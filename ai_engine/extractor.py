from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {
    # Plain text / code
    ".txt", ".md", ".json", ".js", ".ts", ".tsx", ".jsx",
    ".py", ".html", ".css", ".csv", ".xml", ".yaml", ".yml",
    ".toml", ".rs", ".go", ".java", ".c", ".cpp", ".h",
    ".rb", ".sh", ".bat", ".log", ".env", ".sql", ".r",
    # Special parsers
    ".pdf", ".docx", ".xlsx", ".pptx", ".ipynb",
    # Images (OCR)
    ".png", ".jpg", ".jpeg", ".bmp", ".tiff",
}

PLAIN_TEXT_EXTENSIONS = {
    ".txt", ".md", ".json", ".js", ".ts", ".tsx", ".jsx",
    ".py", ".html", ".css", ".csv", ".xml", ".yaml", ".yml",
    ".toml", ".rs", ".go", ".java", ".c", ".cpp", ".h",
    ".rb", ".sh", ".bat", ".log", ".env", ".sql", ".r",
}

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tiff"}


def extract_text(file_path: str, max_size_mb: float = 50) -> str | None:
    """Extract text content from a file. Returns None if unsupported or error."""
    path = Path(file_path)
    ext = path.suffix.lower()

    if ext not in SUPPORTED_EXTENSIONS:
        return None

    try:
        size_mb = path.stat().st_size / (1024 * 1024)
        if size_mb > max_size_mb:
            logger.debug("Skipping %s (%.1f MB > %.1f MB limit)", file_path, size_mb, max_size_mb)
            return None

        if ext in PLAIN_TEXT_EXTENSIONS:
            return _read_plain_text(path)
        elif ext == ".pdf":
            return _read_pdf(path)
        elif ext == ".docx":
            return _read_docx(path)
        elif ext == ".xlsx":
            return _read_xlsx(path)
        elif ext == ".pptx":
            return _read_pptx(path)
        elif ext == ".ipynb":
            return _read_ipynb(path)
        elif ext in IMAGE_EXTENSIONS:
            return _read_image_ocr(path)
    except Exception as e:
        logger.warning("Failed to extract text from %s: %s", file_path, e)
    return None


def _read_plain_text(path: Path) -> str | None:
    for encoding in ("utf-8", "latin-1", "cp1252"):
        try:
            text = path.read_text(encoding=encoding)
            return text.strip() if text.strip() else None
        except (UnicodeDecodeError, ValueError):
            continue
    return None


def _read_pdf(path: Path) -> str | None:
    import pdfplumber

    texts = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                texts.append(text)

    combined = "\n".join(texts).strip()
    if combined:
        return combined

    # Fallback: try OCR if pdfplumber returned nothing (scanned PDF)
    return _read_image_ocr(path)


def _read_docx(path: Path) -> str | None:
    from docx import Document

    doc = Document(str(path))
    texts = [p.text for p in doc.paragraphs if p.text.strip()]
    combined = "\n".join(texts).strip()
    return combined if combined else None


def _read_xlsx(path: Path) -> str | None:
    try:
        from openpyxl import load_workbook

        wb = load_workbook(str(path), read_only=True, data_only=True)
        texts = []
        for sheet in wb.sheetnames[:5]:  # limit to first 5 sheets
            ws = wb[sheet]
            texts.append(f"[Sheet: {sheet}]")
            for row in ws.iter_rows(max_row=500, values_only=True):
                row_text = " | ".join(str(cell) for cell in row if cell is not None)
                if row_text.strip():
                    texts.append(row_text)
        wb.close()
        combined = "\n".join(texts).strip()
        return combined if combined else None
    except ImportError:
        logger.debug("openpyxl not installed, skipping .xlsx")
        return None


def _read_pptx(path: Path) -> str | None:
    try:
        from pptx import Presentation

        prs = Presentation(str(path))
        texts = []
        for slide_num, slide in enumerate(prs.slides, 1):
            slide_texts = []
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        t = para.text.strip()
                        if t:
                            slide_texts.append(t)
            if slide_texts:
                texts.append(f"[Slide {slide_num}]")
                texts.extend(slide_texts)
        combined = "\n".join(texts).strip()
        return combined if combined else None
    except ImportError:
        logger.debug("python-pptx not installed, skipping .pptx")
        return None


def _read_ipynb(path: Path) -> str | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        texts = []
        for cell in data.get("cells", []):
            source = "".join(cell.get("source", []))
            if source.strip():
                cell_type = cell.get("cell_type", "code")
                texts.append(f"[{cell_type}]")
                texts.append(source.strip())
        combined = "\n".join(texts).strip()
        return combined if combined else None
    except Exception:
        return None


_ocr_available: bool | None = None


def _read_image_ocr(path: Path) -> str | None:
    global _ocr_available
    if _ocr_available is False:
        return None

    try:
        import easyocr
        _ocr_available = True

        reader = easyocr.Reader(["en", "tr"], gpu=False, verbose=False)
        results = reader.readtext(str(path))
        texts = [r[1] for r in results if r[1].strip()]
        combined = " ".join(texts).strip()
        return combined if combined else None
    except ImportError:
        _ocr_available = False
        logger.debug("easyocr not installed, skipping OCR for %s", path)
        return None
    except Exception as e:
        logger.warning("OCR failed for %s: %s", path, e)
        return None
