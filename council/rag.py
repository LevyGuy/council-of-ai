"""RAG document handling: extract text from uploaded files."""
from __future__ import annotations

import io
import logging
from dataclasses import dataclass

logger = logging.getLogger("council.rag")

SUPPORTED_MIME_TYPES = {
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/html",
    "application/pdf",
}

MAX_DOCUMENT_CHARS = 80_000  # truncate very long docs to avoid blowing context


@dataclass
class RagDocument:
    filename: str
    content: str
    truncated: bool = False


def extract_text(filename: str, data: bytes, content_type: str) -> RagDocument:
    """Extract plain text from uploaded file bytes."""
    lower_name = filename.lower()

    if content_type == "application/pdf" or lower_name.endswith(".pdf"):
        return _extract_pdf(filename, data)

    # Default: treat as UTF-8 text (covers .txt, .md, .csv, .html, etc.)
    try:
        text = data.decode("utf-8", errors="replace")
    except Exception as e:
        logger.warning("Failed to decode %s as text: %s", filename, e)
        text = data.decode("latin-1", errors="replace")

    return _make_doc(filename, text)


def _extract_pdf(filename: str, data: bytes) -> RagDocument:
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        pages = []
        for page in reader.pages:
            page_text = page.extract_text() or ""
            pages.append(page_text)
        text = "\n\n".join(pages)
        logger.info("Extracted %d chars from PDF %s (%d pages)", len(text), filename, len(pages))
        return _make_doc(filename, text)
    except ImportError:
        return RagDocument(
            filename=filename,
            content="[PDF extraction unavailable: pypdf not installed]",
        )
    except Exception as e:
        logger.error("PDF extraction failed for %s: %s", filename, e)
        return RagDocument(filename=filename, content=f"[PDF extraction error: {e}]")


def _make_doc(filename: str, text: str) -> RagDocument:
    truncated = False
    if len(text) > MAX_DOCUMENT_CHARS:
        text = text[:MAX_DOCUMENT_CHARS]
        truncated = True
        logger.info("Truncated %s to %d chars", filename, MAX_DOCUMENT_CHARS)
    return RagDocument(filename=filename, content=text, truncated=truncated)


def build_rag_context(documents: list[RagDocument]) -> str:
    """Format a list of documents into a context block to prepend to the user query."""
    if not documents:
        return ""

    parts = ["=== Attached Reference Documents ===\n"]
    for i, doc in enumerate(documents, 1):
        header = f"--- Document {i}: {doc.filename}"
        if doc.truncated:
            header += " [truncated]"
        header += " ---"
        parts.append(header)
        parts.append(doc.content.strip())
        parts.append("")  # blank line between docs

    parts.append("=== End of Reference Documents ===")
    return "\n".join(parts)
