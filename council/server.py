import asyncio
import json
import logging
import os
import traceback
from pathlib import Path
from typing import Optional

import markdown
import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from .config import AppConfig, filter_available_models, load_config
from .models import ModelQueue
from .rag import RagDocument, build_rag_context, extract_text
from .session import run_session_events

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("council")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = os.environ.get("COUNCIL_CONFIG", str(PROJECT_ROOT / "config.yaml"))

logger.info("Loading config from %s", CONFIG_PATH)
config: AppConfig = filter_available_models(
    load_config(CONFIG_PATH),
    warn_fn=lambda msg: logger.warning(msg),
)
logger.info("Available models: %s", ", ".join(m.name for m in config.models))

# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------
app = FastAPI(title="Council of AI")

# Serve images
app.mount("/images", StaticFiles(directory=str(PROJECT_ROOT / "images")), name="images")


class RagDocumentRequest(BaseModel):
    filename: str
    content: str


class SessionRequest(BaseModel):
    query: str
    rag_documents: Optional[list[RagDocumentRequest]] = None


@app.get("/", response_class=HTMLResponse)
async def serve_index():
    logger.debug("Serving index.html")
    return FileResponse(str(PROJECT_ROOT / "index.html"))


@app.post("/api/upload")
async def upload_documents(files: list[UploadFile] = File(...)):
    """Accept one or more files and return extracted text for each."""
    results = []
    for upload in files:
        data = await upload.read()
        content_type = upload.content_type or ""
        filename = upload.filename or "unknown"
        logger.info("Upload: %s (%s, %d bytes)", filename, content_type, len(data))
        try:
            doc = extract_text(filename, data, content_type)
            results.append({
                "filename": doc.filename,
                "content": doc.content,
                "truncated": doc.truncated,
                "size": len(data),
            })
        except Exception as e:
            logger.error("Failed to process %s: %s", filename, e)
            results.append({
                "filename": filename,
                "content": "",
                "truncated": False,
                "size": len(data),
                "error": str(e),
            })

    return JSONResponse({"documents": results})


@app.post("/api/session")
async def start_session(req: SessionRequest):
    """Start a council session and stream results as SSE."""
    logger.info("=== New session: query=%r ===", req.query)

    # Build RAG context string from any attached documents
    rag_docs: list[RagDocument] = []
    if req.rag_documents:
        for d in req.rag_documents:
            rag_docs.append(RagDocument(filename=d.filename, content=d.content))
        logger.info("RAG documents attached: %d", len(rag_docs))

    rag_context = build_rag_context(rag_docs)

    queue = ModelQueue(config.models, shuffle=config.session.shuffle)
    logger.info("Panel order: %s", ", ".join(queue.order_names))

    async def event_generator():
        loop = asyncio.get_event_loop()
        q: asyncio.Queue = asyncio.Queue()

        def _run_sync():
            """Run the synchronous session generator in a thread."""
            event_count = 0
            try:
                logger.debug("Background thread started")
                for event in run_session_events(
                    queue, req.query, config.session.max_iterations, rag_context=rag_context
                ):
                    event_count += 1
                    etype = event.get("type", "unknown")
                    if etype == "chunk":
                        pass  # Don't log every chunk
                    else:
                        logger.debug("Event #%d: %s", event_count, etype)
                    # Thread-safe put into the asyncio queue
                    loop.call_soon_threadsafe(q.put_nowait, event)
                logger.info("Session generator finished (%d events)", event_count)
            except Exception as e:
                logger.error("Session error: %s\n%s", e, traceback.format_exc())
                loop.call_soon_threadsafe(
                    q.put_nowait,
                    {"type": "error", "model": "system", "message": str(e)},
                )
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)  # sentinel

        # Run the blocking session in a thread
        task = loop.run_in_executor(None, _run_sync)

        while True:
            event = await q.get()
            if event is None:
                logger.debug("Sentinel received, ending SSE stream")
                break

            # Convert turn_end content from markdown to HTML
            if event["type"] == "turn_end":
                md_content = event.get("content", "")
                event["html"] = markdown.markdown(
                    md_content,
                    extensions=["fenced_code", "tables", "nl2br"],
                )
                logger.debug("Converted turn_end markdown -> HTML (%d chars)", len(event["html"]))

            # Save transcript for the done event
            if event["type"] == "done":
                transcript = event["transcript"]
                try:
                    path = transcript.save(config.session.transcript_dir)
                    logger.info("Transcript saved to %s", path)
                    event = {
                        "type": "done",
                        "iterations": len(transcript.iterations),
                        "transcript": path,
                    }
                except Exception as e:
                    logger.error("Failed to save transcript: %s", e)
                    event = {
                        "type": "done",
                        "iterations": len(transcript.iterations),
                        "transcript": None,
                    }

            yield {"data": json.dumps(event)}

        await task  # propagate exceptions

    return EventSourceResponse(event_generator())


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    logger.info("Starting web server on http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")


if __name__ == "__main__":
    main()
