from __future__ import annotations

import logging
import os
from typing import Optional

import numpy as np

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TRANSFORMERS_NO_TF"] = "1"
os.environ["USE_TORCH"] = "1"

logger = logging.getLogger(__name__)

_model = None
_model_name = "paraphrase-multilingual-MiniLM-L12-v2"
EMBEDDING_DIM = 384


def load_model(model_name: Optional[str] = None) -> None:
    global _model, _model_name
    if model_name:
        _model_name = model_name
    if _model is not None:
        return
    logger.info("Loading embedding model: %s", _model_name)
    from sentence_transformers import SentenceTransformer

    _model = SentenceTransformer(_model_name)
    logger.info("Model loaded (dim=%d, device=%s)", EMBEDDING_DIM, _model.device)


def get_embedding(text: str) -> np.ndarray:
    if _model is None:
        load_model()
    return _model.encode(text, normalize_embeddings=True, convert_to_numpy=True)


def get_embeddings(texts: list[str], batch_size: int = 256) -> np.ndarray:
    if _model is None:
        load_model()
    return _model.encode(
        texts,
        normalize_embeddings=True,
        batch_size=batch_size,
        show_progress_bar=False,
        convert_to_numpy=True,
    )
