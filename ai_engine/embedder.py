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

# Default to high-accuracy multilingual model with 384 dimensions
_model_name = os.environ.get(
    "LOCALMIND_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
EMBEDDING_DIM = 384

# Sequence length is the main lever on embedding cost: work grows with the
# padded token count, not with the text you care about.
MAX_SEQ_LENGTH = int(os.environ.get("LOCALMIND_MAX_SEQ", "192"))

_load_lock = threading.Lock()


def quantize_enabled() -> bool:
    """int8 dynamic quantization roughly doubles indexing throughput on CPU at
    some cost in embedding fidelity. Changing it invalidates the index."""
    return bool(settings.get("quantize"))


def model_signature() -> str:
    """Identifies the vector space and backend. Any change here invalidates a stored index."""
    clean_name = _model_name.split("/")[-1]
    return f"onnx|{clean_name}|seq{MAX_SEQ_LENGTH}|{'int8' if quantize_enabled() else 'fp32'}"


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

    # 2. Locate ONNX model (try local first)
    onnx_file = None
    candidates = []
    if quantize:
        candidates.extend(["onnx/model_quantized.onnx", "model_quantized.onnx"])
    candidates.extend(["onnx/model.onnx", "model.onnx"])

    for candidate in candidates:
        try:
            onnx_file = hf_hub_download(
                repo_id=model_name,
                filename=candidate,
                local_files_only=True,
                cache_dir=cache_dir,
            )
            if onnx_file and os.path.exists(onnx_file):
                logger.info("Loaded cached ONNX model variant: %s", candidate)
                return tok_file, onnx_file
        except Exception:
            continue

    # 3. If not cached locally, download online
    for candidate in candidates:
        try:
            onnx_file = hf_hub_download(
                repo_id=model_name,
                filename=candidate,
                cache_dir=cache_dir,
            )
            if onnx_file and os.path.exists(onnx_file):
                logger.info("Downloaded ONNX model variant: %s", candidate)
                break
        except Exception:
            continue

    if not onnx_file:
        onnx_file = hf_hub_download(
            repo_id=model_name,
            filename="onnx/model.onnx",
            cache_dir=cache_dir,
        )

    return tok_file, onnx_file


def reload_model() -> None:
    """Drop the loaded model so the next call rebuilds it from current settings."""
    global _session, _tokenizer
    with _load_lock:
        _session = None
        _tokenizer = None
    import gc
    gc.collect()
    load_model()


def load_model(model_name: Optional[str] = None) -> None:
    """Initialize ONNX Runtime inference session and fast tokenizer."""
    global _session, _tokenizer, _model_name, _input_names
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

        # Configure Tokenizer
        tok = Tokenizer.from_file(tok_file)
        tok.enable_truncation(max_length=MAX_SEQ_LENGTH)
        tok.enable_padding(length=MAX_SEQ_LENGTH)
        _tokenizer = tok

        # Configure ONNX Runtime Session with DirectML (GPU) prioritization
        sess_options = ort.SessionOptions()
        sess_options.intra_op_num_threads = threads
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        available_providers = ort.get_available_providers()
        providers = []
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


def get_embeddings(texts: list[str], batch_size: int = 128) -> np.ndarray:
    """Generate normalized 384-d float32 embeddings for a batch of texts."""
    if not texts:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

    if _session is None or _tokenizer is None:
        load_model()

    all_embeddings: list[np.ndarray] = []

    for i in range(0, len(texts), batch_size):
        chunk = texts[i : i + batch_size]
        encs = _tokenizer.encode_batch(chunk)

        input_ids = np.array([e.ids for e in encs], dtype=np.int64)
        attention_mask = np.array([e.attention_mask for e in encs], dtype=np.int64)

        inputs = {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
        }
        if "token_type_ids" in _input_names:
            inputs["token_type_ids"] = np.array([e.type_ids for e in encs], dtype=np.int64)

        outputs = _session.run(None, inputs)[0]
        pooled = _mean_pooling_and_normalize(outputs, attention_mask)
        all_embeddings.append(pooled)

    if len(all_embeddings) == 1:
        return all_embeddings[0]
    return np.vstack(all_embeddings).astype(np.float32)
