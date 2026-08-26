from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Optional
import numpy as np

import settings

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TRANSFORMERS_NO_TF"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

logger = logging.getLogger(__name__)

_session = None
_tokenizer = None
_input_names: set[str] = set()
# Precision of the model actually loaded, once one has been. None until then.
_active_quantized: bool | None = None

# Default to high-accuracy multilingual model with 384 dimensions
_model_name = os.environ.get(
    "LOCALMIND_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
EMBEDDING_DIM = 384

# Sequence length is the main lever on embedding cost: work grows with the
# padded token count, not with the text you care about.
MAX_SEQ_LENGTH = int(os.environ.get("LOCALMIND_MAX_SEQ", "192"))
# Batches are padded to their own longest sequence rounded up to this multiple,
# so short chunks stop paying for a full-length forward pass while the model
# still only ever sees a handful of distinct input shapes.
PAD_MULTIPLE = int(os.environ.get("LOCALMIND_PAD_MULTIPLE", "32"))
# Default inference batch. This is the main memory/throughput dial: the model's
# activations are batch x sequence x hidden, so doubling it doubles the transient
# allocation. Measured on a mixed 900-file corpus, 32 runs within 10% of 64 while
# holding 24MB less, so the smaller batch is the better default.
DEFAULT_BATCH = int(os.environ.get("LOCALMIND_EMBED_BATCH", "32"))

_load_lock = threading.Lock()


def _pad_token_config(tok) -> dict:
    """Find the tokenizer's real padding token.

    Hard-coding id 0 / "[PAD]" happens to be harmless here (padded positions are
    masked out before pooling) but it is wrong for the XLM-R vocabulary this
    model uses, where 0 is <s>. Read it from the tokenizer when it says.
    """
    existing = getattr(tok, "padding", None)
    if isinstance(existing, dict) and existing.get("pad_token") is not None:
        return {"pad_id": existing.get("pad_id", 0), "pad_token": existing["pad_token"]}
    for candidate in ("<pad>", "[PAD]", "<|endoftext|>"):
        tid = tok.token_to_id(candidate)
        if tid is not None:
            return {"pad_id": tid, "pad_token": candidate}
    return {"pad_id": 0, "pad_token": "[PAD]"}


_gpu_probe: bool | None = None


def gpu_available() -> bool:
    """Whether ONNX Runtime has a GPU execution provider on this machine."""
    global _gpu_probe
    if _gpu_probe is None:
        try:
            import onnxruntime as ort

            available = set(ort.get_available_providers())
            _gpu_probe = bool(available & {"DmlExecutionProvider", "CUDAExecutionProvider"})
        except Exception:
            _gpu_probe = False
    return _gpu_probe


def quantize_enabled() -> bool:
    """Whether to run the int8 model. Unset means decide from the hardware.

    int8 is not universally faster, which the old "roughly 2x faster indexing"
    framing got wrong. Dynamic quantization emits ops that DirectML cannot run,
    so on a DirectX 12 GPU the int8 graph falls back to the CPU and ends up
    slower than fp32 on the GPU. Measured on this codebase, embedding a mixed
    600-chunk batch:

        fp32 on DirectML   448 chunks/s   1216 MB peak RSS
        fp32 on CPU        112 chunks/s   1143 MB
        int8 on CPU        206 chunks/s    556 MB

    So on a GPU machine int8 trades 2.2x throughput for 2.2x less memory --
    a real choice, left to the user. On a CPU-only machine int8 is both faster
    and lighter, so there is nothing to weigh: it simply wins. The default
    picks accordingly; an explicit setting always overrides it.
    """
    configured = settings.get("quantize")
    if configured is None:
        return not gpu_available()
    return bool(configured)


def model_signature() -> str:
    """Identifies the vector space and backend. Any change here invalidates a stored index.

    This reports the precision actually in use once a model has been loaded,
    not the precision that was asked for. If quantization is requested but the
    conversion fails, the engine runs fp32 -- and marking that index "int8"
    would let a later successful conversion write int8 vectors alongside the
    fp32 ones without ever triggering a rebuild.
    """
    clean_name = _model_name.split("/")[-1]
    quantized = _active_quantized if _active_quantized is not None else quantize_enabled()
    return f"onnx|{clean_name}|seq{MAX_SEQ_LENGTH}|{'int8' if quantized else 'fp32'}"


def _get_model_files(model_name: str, quantize: bool) -> tuple[str, str]:
    """Retrieve or download tokenizer.json and ONNX model file, prioritizing local cache."""
    from huggingface_hub import hf_hub_download

    cache_dir = os.path.join(str(Path.home()), ".localmind", "models")
    os.makedirs(cache_dir, exist_ok=True)

    # 1. Download/locate tokenizer.json (try local first)
    tok_file = None
    try:
        tok_file = hf_hub_download(
            repo_id=model_name,
            filename="tokenizer.json",
            local_files_only=True,
            cache_dir=cache_dir,
        )
    except Exception:
        tok_file = hf_hub_download(
            repo_id=model_name,
            filename="tokenizer.json",
            cache_dir=cache_dir,
        )

    def fetch(filename: str, local_only: bool) -> str | None:
        try:
            path = hf_hub_download(
                repo_id=model_name,
                filename=filename,
                local_files_only=local_only,
                cache_dir=cache_dir,
            )
            return path if path and os.path.exists(path) else None
        except Exception:
            return None

    QUANTIZED = ("onnx/model_quantized.onnx", "model_quantized.onnx")
    FP32 = ("onnx/model.onnx", "model.onnx")

    # 2. A quantized model published by the repo is the best case: no local
    # conversion needed. Only these count as "already quantized" -- the search
    # used to fall through to the fp32 files in the same loop and return one of
    # them, which meant that with quantization enabled but no published int8
    # variant (the case for this model) the engine silently loaded the 449MB
    # fp32 weights, spent ~2x the time indexing, and still reported int8.
    if quantize:
        for candidate in QUANTIZED:
            for local_only in (True, False):
                path = fetch(candidate, local_only)
                if path:
                    logger.info("Using published int8 ONNX model: %s", candidate)
                    return tok_file, path

        # A conversion done on a previous run is cached next to the models.
        quantized_local = os.path.join(
            cache_dir, f"{model_name.replace('/', '_')}_int8.onnx"
        )
        if os.path.exists(quantized_local):
            logger.info("Using locally quantized int8 model: %s", quantized_local)
            return tok_file, quantized_local

    # 3. Otherwise get the fp32 model, preferring whatever is already on disk.
    onnx_file = None
    for local_only in (True, False):
        for candidate in FP32:
            onnx_file = fetch(candidate, local_only)
            if onnx_file:
                break
        if onnx_file:
            break

    if not onnx_file:
        onnx_file = hf_hub_download(
            repo_id=model_name,
            filename="onnx/model.onnx",
            cache_dir=cache_dir,
        )

    if not quantize:
        return tok_file, onnx_file

    # 4. Convert to int8 once and cache it. Roughly a quarter of the memory and
    # about twice the throughput, at a small cost in embedding fidelity.
    try:
        from onnxruntime.quantization import quantize_dynamic, QuantType

        logger.info("Quantizing %s to int8 (one-off, takes a minute)...", model_name)
        tmp_out = quantized_local + ".tmp"
        quantize_dynamic(
            model_input=onnx_file,
            model_output=tmp_out,
            weight_type=QuantType.QInt8,
        )
        # Publish atomically so an interrupted conversion never leaves a
        # truncated file that the next launch would happily try to load.
        os.replace(tmp_out, quantized_local)
        logger.info(
            "int8 quantization complete: %s (%.0f MB, was %.0f MB)",
            quantized_local,
            os.path.getsize(quantized_local) / (1024 * 1024),
            os.path.getsize(onnx_file) / (1024 * 1024),
        )
        return tok_file, quantized_local
    except Exception as e:
        logger.warning("Dynamic int8 quantization failed, falling back to fp32: %s", e)

    return tok_file, onnx_file


def reload_model() -> None:
    """Drop the loaded model so the next call rebuilds it from current settings."""
    global _session, _tokenizer, _active_quantized
    with _load_lock:
        _session = None
        _tokenizer = None
        _active_quantized = None
    import gc
    gc.collect()
    load_model()


def load_model(model_name: Optional[str] = None) -> None:
    """Initialize ONNX Runtime inference session and fast tokenizer."""
    global _session, _tokenizer, _model_name, _input_names, _active_quantized
    if model_name:
        _model_name = model_name

    if _session is not None and _tokenizer is not None:
        return

    with _load_lock:
        if _session is not None and _tokenizer is not None:
            return

        import onnxruntime as ort
        from tokenizers import Tokenizer

        cpu = os.cpu_count() or 4
        threads = int(os.environ.get("LOCALMIND_ONNX_THREADS", "0")) or max(2, min(8, cpu // 2))

        logger.info(
            "Loading ONNX embedding model: %s (%d threads, int8=%s)",
            _model_name,
            threads,
            quantize_enabled(),
        )

        tok_file, onnx_file = _get_model_files(_model_name, quantize_enabled())
        # What came back is the source of truth: a requested int8 conversion can
        # fail and fall back to fp32, and the stored index must be labelled with
        # whichever one is really producing the vectors.
        loaded_name = os.path.basename(onnx_file).lower()
        _active_quantized = "int8" in loaded_name or "quantized" in loaded_name

        # Configure Tokenizer.
        #
        # Padding is dynamic: every batch is padded to its own longest sequence,
        # rounded up to PAD_MULTIPLE. Padding every chunk to the full
        # MAX_SEQ_LENGTH meant a 40-token chunk cost the same inference as a
        # 192-token one; most chunks are well short of the limit, so the run
        # spent a large share of its time multiplying padding by weights.
        # Rounding to a multiple keeps the number of distinct input shapes tiny
        # (6 instead of 192), which matters because ONNX Runtime -- and
        # DirectML especially -- re-plans execution for every unseen shape.
        tok = Tokenizer.from_file(tok_file)
        tok.enable_truncation(max_length=MAX_SEQ_LENGTH)
        tok.enable_padding(pad_to_multiple_of=PAD_MULTIPLE, **_pad_token_config(tok))
        _tokenizer = tok

        # Configure ONNX Runtime Session with DirectML (GPU) prioritization
        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = threads
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess_options.enable_cpu_mem_arena = False
        sess_options.enable_mem_pattern = True

        available_providers = ort.get_available_providers()
        providers = []
        # A GPU provider only helps the fp32 graph. Dynamic quantization emits
        # DynamicQuantizeLinear/MatMulInteger, which DirectML cannot execute, so
        # an int8 session offered DirectML runs the same speed as on CPU while
        # holding an extra ~155MB for a GPU partition it never uses.
        if _active_quantized:
            logger.info("Running int8 on CPU: GPU providers cannot execute quantized ops")
        else:
            if "DmlExecutionProvider" in available_providers:
                providers.append("DmlExecutionProvider")
                logger.info("DirectML GPU Execution Provider enabled (DirectX 12)")
            if "CUDAExecutionProvider" in available_providers:
                providers.append("CUDAExecutionProvider")
        providers.append("CPUExecutionProvider")

        _session = ort.InferenceSession(
            onnx_file,
            sess_options=sess_options,
            providers=providers,
        )
        _input_names = {inp.name for inp in _session.get_inputs()}

        active_provider = _session.get_providers()[0] if _session.get_providers() else "Unknown"
        logger.info("Active ONNX Provider: %s", active_provider)

        # Warm-up inference
        get_embedding("localmind warmup")
        logger.info("ONNX Embedding model loaded and warmed up (dim=%d, device=%s)", EMBEDDING_DIM, active_provider)


def _mean_pooling_and_normalize(outputs: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    """Mean Pooling: Take attention mask into account and apply L2 normalization."""
    mask_expanded = np.expand_dims(attention_mask, -1).repeat(outputs.shape[-1], -1)
    sum_embeddings = np.sum(outputs * mask_expanded, axis=1)
    sum_mask = np.clip(mask_expanded.sum(axis=1), a_min=1e-9, a_max=None)
    embeddings = sum_embeddings / sum_mask
    norms = np.linalg.norm(embeddings, ord=2, axis=1, keepdims=True)
    return (embeddings / np.clip(norms, a_min=1e-12, a_max=None)).astype(np.float32)


def get_embedding(text: str) -> np.ndarray:
    """Generate normalized 384-d float32 vector embedding for a single text."""
    if _session is None or _tokenizer is None:
        load_model()

    enc = _tokenizer.encode(text)
    input_ids = np.array([enc.ids], dtype=np.int64)
    attention_mask = np.array([enc.attention_mask], dtype=np.int64)

    inputs = {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
    }
    if "token_type_ids" in _input_names:
        inputs["token_type_ids"] = np.array([enc.type_ids], dtype=np.int64)

    outputs = _session.run(None, inputs)[0]
    pooled = _mean_pooling_and_normalize(outputs, attention_mask)
    return pooled[0]


def _run_batch(chunk: list[str]) -> np.ndarray:
    """Tokenize, pad to this batch's own longest sequence, and run the model."""
    encs = _tokenizer.encode_batch(chunk)

    input_ids = np.asarray([e.ids for e in encs], dtype=np.int64)
    attention_mask = np.asarray([e.attention_mask for e in encs], dtype=np.int64)

    inputs = {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
    }
    if "token_type_ids" in _input_names:
        inputs["token_type_ids"] = np.asarray([e.type_ids for e in encs], dtype=np.int64)

    outputs = _session.run(None, inputs)[0]
    return _mean_pooling_and_normalize(outputs, attention_mask)


def get_embeddings(texts: list[str], batch_size: int = DEFAULT_BATCH) -> np.ndarray:
    """Generate normalized 384-d float32 embeddings for a list of texts.

    Texts are grouped by length before batching. A batch costs the length of its
    longest member times its size, so mixing a 30-token chunk with a 190-token
    one made the short chunk six times more expensive than it needed to be.
    Sorting by length first means each batch is nearly uniform and the padding
    added by `pad_to_multiple_of` is all that is wasted. Results are written
    back in the caller's original order.
    """
    if not texts:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

    if _session is None or _tokenizer is None:
        load_model()

    n = len(texts)
    if n <= batch_size:
        return np.ascontiguousarray(_run_batch(texts))

    # Character count is a cheap, well-correlated stand-in for token count --
    # accurate enough for bucketing, and it avoids tokenizing the whole list
    # up front just to measure it.
    order = sorted(range(n), key=lambda i: len(texts[i]))

    out = np.empty((n, EMBEDDING_DIM), dtype=np.float32)
    for start in range(0, n, batch_size):
        idxs = order[start : start + batch_size]
        pooled = _run_batch([texts[i] for i in idxs])
        out[idxs] = pooled
    return out
