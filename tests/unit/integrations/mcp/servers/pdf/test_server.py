"""
Unit tests for PDF MCP server.

Tests all 6 tools: merge_pdfs, split_pdf, extract_text, extract_tables, rotate_pages, pdf_info
"""

import pytest
import os
import sys
import tempfile
from pathlib import Path
import json

# Add server module to path
server_path = Path(__file__).parent.parent.parent.parent.parent.parent.parent / "src" / "integrations" / "mcp" / "servers" / "pdf"
sys.path.insert(0, str(server_path))

# Import server functions
from server import merge_pdfs, split_pdf, extract_text, extract_tables, rotate_pages, pdf_info

# Import PDF libraries for test setup
from pypdf import PdfReader, PdfWriter


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


@pytest.fixture
def sample_pdf(temp_dir):
    """Create a simple test PDF with 3 pages."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import letter

    pdf_path = os.path.join(temp_dir, "sample.pdf")
    c = canvas.Canvas(pdf_path, pagesize=letter)

    # Page 1
    c.drawString(100, 750, "Page 1")
    c.drawString(100, 700, "This is the first page")
    c.showPage()

    # Page 2
    c.drawString(100, 750, "Page 2")
    c.drawString(100, 700, "This is the second page")
    c.showPage()

    # Page 3
    c.drawString(100, 750, "Page 3")
    c.drawString(100, 700, "This is the third page")
    c.showPage()

    c.save()
    return pdf_path


@pytest.fixture
def sample_pdf2(temp_dir):
    """Create a second test PDF with 2 pages."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import letter

    pdf_path = os.path.join(temp_dir, "sample2.pdf")
    c = canvas.Canvas(pdf_path, pagesize=letter)

    # Page 1
    c.drawString(100, 750, "Document 2 - Page 1")
    c.showPage()

    # Page 2
    c.drawString(100, 750, "Document 2 - Page 2")
    c.showPage()

    c.save()
    return pdf_path


# ── merge_pdfs tests ──────────────────────────────────────

@pytest.mark.asyncio
async def test_merge_pdfs_success(sample_pdf, sample_pdf2, temp_dir):
    """Test successful merge of two PDFs."""
    output_path = os.path.join(temp_dir, "merged.pdf")

    result = await merge_pdfs(
        files=[sample_pdf, sample_pdf2],
        output_path=output_path
    )

    assert result["success"] is True
    assert "output_files" in result
    assert len(result["output_files"]) == 1
    assert result["output_files"][0]["path"] == output_path
    assert os.path.exists(output_path)

    # Verify merged PDF has 5 pages (3 + 2)
    reader = PdfReader(output_path)
    assert len(reader.pages) == 5
    assert result["page_count"] == 5


@pytest.mark.asyncio
async def test_merge_pdfs_insufficient_files(temp_dir):
    """Test merge with less than 2 files."""
    output_path = os.path.join(temp_dir, "merged.pdf")

    result = await merge_pdfs(
        files=["single.pdf"],
        output_path=output_path
    )

    assert result["success"] is False
    assert "at least 2 PDF files" in result["error"].lower()


@pytest.mark.asyncio
async def test_merge_pdfs_nonexistent_file(sample_pdf, temp_dir):
    """Test merge with a nonexistent file."""
    output_path = os.path.join(temp_dir, "merged.pdf")

    result = await merge_pdfs(
        files=[sample_pdf, "/nonexistent/file.pdf"],
        output_path=output_path
    )

    assert result["success"] is False
    assert "not found" in result["error"].lower()


@pytest.mark.asyncio
async def test_merge_pdfs_creates_output_dir(sample_pdf, sample_pdf2, temp_dir):
    """Test that merge creates output directory if needed."""
    output_path = os.path.join(temp_dir, "subdir", "merged.pdf")

    result = await merge_pdfs(
        files=[sample_pdf, sample_pdf2],
        output_path=output_path
    )

    assert result["success"] is True
    assert os.path.exists(output_path)


# ── split_pdf tests ───────────────────────────────────────

@pytest.mark.asyncio
async def test_split_pdf_single_pages(sample_pdf, temp_dir):
    """Test splitting PDF into individual pages."""
    output_dir = os.path.join(temp_dir, "split")

    result = await split_pdf(
        file=sample_pdf,
        pages="1,2,3",
        output_dir=output_dir
    )

    assert result["success"] is True
    assert len(result["output_files"]) == 3
    assert all(os.path.exists(f["path"]) for f in result["output_files"])


@pytest.mark.asyncio
async def test_split_pdf_page_ranges(sample_pdf, temp_dir):
    """Test splitting PDF with page ranges."""
    output_dir = os.path.join(temp_dir, "split")

    result = await split_pdf(
        file=sample_pdf,
        pages="1-2,3",
        output_dir=output_dir
    )

    assert result["success"] is True
    assert len(result["output_files"]) == 2

    # First file should have pages 1-2
    reader1 = PdfReader(result["output_files"][0]["path"])
    assert len(reader1.pages) == 2

    # Second file should have page 3
    reader2 = PdfReader(result["output_files"][1]["path"])
    assert len(reader2.pages) == 1


@pytest.mark.asyncio
async def test_split_pdf_all_pages(sample_pdf, temp_dir):
    """Test splitting all pages."""
    output_dir = os.path.join(temp_dir, "split")

    result = await split_pdf(
        file=sample_pdf,
        pages="all",
        output_dir=output_dir
    )

    assert result["success"] is True
    assert len(result["output_files"]) == 3


@pytest.mark.asyncio
async def test_split_pdf_invalid_page_range(sample_pdf, temp_dir):
    """Test split with invalid page range."""
    output_dir = os.path.join(temp_dir, "split")

    result = await split_pdf(
        file=sample_pdf,
        pages="1-10",  # sample_pdf only has 3 pages
        output_dir=output_dir
    )

    assert result["success"] is False
    assert "invalid page range" in result["error"].lower()


@pytest.mark.asyncio
async def test_split_pdf_nonexistent_file(temp_dir):
    """Test split with nonexistent file."""
    output_dir = os.path.join(temp_dir, "split")

    result = await split_pdf(
        file="/nonexistent/file.pdf",
        pages="1",
        output_dir=output_dir
    )

    assert result["success"] is False
    assert "not found" in result["error"].lower()


# ── extract_text tests ────────────────────────────────────

@pytest.mark.asyncio
async def test_extract_text_all_pages(sample_pdf):
    """Test extracting text from all pages."""
    result = await extract_text(file=sample_pdf)

    assert result["success"] is True
    assert result["total_pages"] == 3
    assert result["extracted_pages"] == 3
    assert "1" in result["text"]
    assert "2" in result["text"]
    assert "3" in result["text"]
    assert "Page 1" in result["text"]["1"]


@pytest.mark.asyncio
async def test_extract_text_specific_pages(sample_pdf):
    """Test extracting text from specific pages."""
    result = await extract_text(file=sample_pdf, pages="1,3")

    assert result["success"] is True
    assert result["total_pages"] == 3
    assert result["extracted_pages"] == 2
    assert "1" in result["text"]
    assert "2" not in result["text"]
    assert "3" in result["text"]


@pytest.mark.asyncio
async def test_extract_text_page_range(sample_pdf):
    """Test extracting text from page range."""
    result = await extract_text(file=sample_pdf, pages="1-2")

    assert result["success"] is True
    assert result["extracted_pages"] == 2
    assert "1" in result["text"]
    assert "2" in result["text"]
    assert "3" not in result["text"]


@pytest.mark.asyncio
async def test_extract_text_invalid_page(sample_pdf):
    """Test extract with invalid page number."""
    result = await extract_text(file=sample_pdf, pages="10")

    assert result["success"] is False
    assert "invalid page number" in result["error"].lower()


@pytest.mark.asyncio
async def test_extract_text_nonexistent_file():
    """Test extract from nonexistent file."""
    result = await extract_text(file="/nonexistent/file.pdf")

    assert result["success"] is False
    assert "not found" in result["error"].lower()


# ── extract_tables tests ──────────────────────────────────

@pytest.mark.asyncio
async def test_extract_tables_json_format(sample_pdf):
    """Test extracting tables in JSON format."""
    result = await extract_tables(file=sample_pdf, format="json")

    assert result["success"] is True
    assert result["total_pages"] == 3
    assert result["format"] == "json"
    # sample_pdf has no tables, so pages_with_tables should be 0
    assert result["pages_with_tables"] == 0


@pytest.mark.asyncio
async def test_extract_tables_csv_format(sample_pdf):
    """Test extracting tables in CSV format."""
    result = await extract_tables(file=sample_pdf, format="csv")

    assert result["success"] is True
    assert result["format"] == "csv"


@pytest.mark.asyncio
async def test_extract_tables_invalid_format(sample_pdf):
    """Test extract with invalid format."""
    result = await extract_tables(file=sample_pdf, format="xml")

    assert result["success"] is False
    assert "invalid format" in result["error"].lower()


@pytest.mark.asyncio
async def test_extract_tables_specific_pages(sample_pdf):
    """Test extracting tables from specific pages."""
    result = await extract_tables(file=sample_pdf, pages="1", format="json")

    assert result["success"] is True
    assert result["total_pages"] == 3


# ── rotate_pages tests ────────────────────────────────────

@pytest.mark.asyncio
async def test_rotate_pages_all_90_degrees(sample_pdf, temp_dir):
    """Test rotating all pages 90 degrees."""
    output_path = os.path.join(temp_dir, "rotated.pdf")

    result = await rotate_pages(
        file=sample_pdf,
        rotation=90,
        output_path=output_path
    )

    assert result["success"] is True
    assert "output_files" in result
    assert os.path.exists(output_path)

    # Verify output has same page count
    reader = PdfReader(output_path)
    assert len(reader.pages) == 3


@pytest.mark.asyncio
async def test_rotate_pages_specific_pages(sample_pdf, temp_dir):
    """Test rotating specific pages."""
    output_path = os.path.join(temp_dir, "rotated.pdf")

    result = await rotate_pages(
        file=sample_pdf,
        rotation=180,
        pages="1,3",
        output_path=output_path
    )

    assert result["success"] is True
    assert os.path.exists(output_path)


@pytest.mark.asyncio
async def test_rotate_pages_default_output(sample_pdf, temp_dir):
    """Test rotation with default output path."""
    result = await rotate_pages(
        file=sample_pdf,
        rotation=90
    )

    assert result["success"] is True
    assert "output_files" in result
    # Default output should be in same directory
    output_path = result["output_files"][0]["path"]
    assert "_rotated" in output_path


@pytest.mark.asyncio
async def test_rotate_pages_invalid_rotation(sample_pdf, temp_dir):
    """Test rotate with invalid rotation angle."""
    output_path = os.path.join(temp_dir, "rotated.pdf")

    result = await rotate_pages(
        file=sample_pdf,
        rotation=45,  # Invalid angle
        output_path=output_path
    )

    assert result["success"] is False
    assert "invalid rotation" in result["error"].lower()


@pytest.mark.asyncio
async def test_rotate_pages_nonexistent_file(temp_dir):
    """Test rotate with nonexistent file."""
    output_path = os.path.join(temp_dir, "rotated.pdf")

    result = await rotate_pages(
        file="/nonexistent/file.pdf",
        rotation=90,
        output_path=output_path
    )

    assert result["success"] is False
    assert "not found" in result["error"].lower()


# ── pdf_info tests ────────────────────────────────────────

@pytest.mark.asyncio
async def test_pdf_info_success(sample_pdf):
    """Test getting PDF info."""
    result = await pdf_info(file=sample_pdf)

    assert result["success"] is True
    assert result["page_count"] == 3
    assert result["file_name"] == "sample.pdf"
    assert result["file_path"] == sample_pdf
    assert "file_size" in result
    assert "file_size_formatted" in result
    assert "metadata" in result


@pytest.mark.asyncio
async def test_pdf_info_file_size_formatting(sample_pdf):
    """Test that file size is properly formatted."""
    result = await pdf_info(file=sample_pdf)

    assert result["success"] is True
    # Should have formatted size (KB or MB)
    assert any(unit in result["file_size_formatted"] for unit in ["bytes", "KB", "MB"])


@pytest.mark.asyncio
async def test_pdf_info_metadata(sample_pdf):
    """Test that metadata fields are present."""
    result = await pdf_info(file=sample_pdf)

    assert result["success"] is True
    metadata = result["metadata"]
    # These fields should exist (may be empty)
    assert "title" in metadata
    assert "author" in metadata
    assert "subject" in metadata
    assert "creator" in metadata
    assert "producer" in metadata


@pytest.mark.asyncio
async def test_pdf_info_nonexistent_file():
    """Test info with nonexistent file."""
    result = await pdf_info(file="/nonexistent/file.pdf")

    assert result["success"] is False
    assert "not found" in result["error"].lower()
