#!/usr/bin/env python3
"""
PDF MCP Server - Provides PDF processing tools via MCP protocol.

Tools:
- merge_pdfs: Merge multiple PDFs into one
- split_pdf: Split PDF by page ranges
- extract_text: Extract text from PDF pages
- extract_tables: Extract tables from PDF as JSON/CSV
- rotate_pages: Rotate pages in a PDF
- pdf_info: Get PDF metadata and info
"""

import sys
import os
import json
from pathlib import Path
from typing import Optional, Any

from mcp.server import FastMCP
from pypdf import PdfReader, PdfWriter
import pdfplumber
import pandas as pd


async def merge_pdfs(files: list[str], output_path: str) -> dict[str, Any]:
    """
    Merge multiple PDF files into a single PDF.

    Args:
        files: List of absolute paths to PDF files to merge
        output_path: Absolute path where merged PDF should be saved

    Returns:
        JSON with success status and output_files list
    """
    try:
        if not files or len(files) < 2:
            return {
                "success": False,
                "error": "At least 2 PDF files are required for merging"
            }

        # Validate all input files exist
        for file_path in files:
            if not os.path.exists(file_path):
                return {
                    "success": False,
                    "error": f"Input file not found: {file_path}"
                }

        # Create output directory if needed
        output_dir = os.path.dirname(output_path)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)

        # Merge PDFs
        writer = PdfWriter()
        for file_path in files:
            reader = PdfReader(file_path)
            for page in reader.pages:
                writer.add_page(page)

        # Write merged PDF
        with open(output_path, 'wb') as output_file:
            writer.write(output_file)

        return {
            "success": True,
            "message": f"Successfully merged {len(files)} PDFs into {output_path}",
            "page_count": len(writer.pages),
            "output_files": [{
                "name": os.path.basename(output_path),
                "path": output_path
            }]
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to merge PDFs: {str(e)}"
        }


async def split_pdf(file: str, pages: str, output_dir: str) -> dict[str, Any]:
    """
    Split a PDF into multiple files based on page ranges.

    Args:
        file: Absolute path to input PDF
        pages: Page ranges (e.g., "1-3,5,7-9" or "all")
        output_dir: Directory where split PDFs should be saved

    Returns:
        JSON with success status and output_files list
    """
    try:
        if not os.path.exists(file):
            return {
                "success": False,
                "error": f"Input file not found: {file}"
            }

        reader = PdfReader(file)
        total_pages = len(reader.pages)

        # Parse page ranges
        if pages.lower() == "all":
            page_ranges = [(i, i) for i in range(total_pages)]
        else:
            page_ranges = []
            for part in pages.split(','):
                part = part.strip()
                if '-' in part:
                    start, end = part.split('-')
                    start = int(start) - 1  # Convert to 0-indexed
                    end = int(end) - 1
                    if start < 0 or end >= total_pages or start > end:
                        return {
                            "success": False,
                            "error": f"Invalid page range: {part} (PDF has {total_pages} pages)"
                        }
                    page_ranges.append((start, end))
                else:
                    page_num = int(part) - 1  # Convert to 0-indexed
                    if page_num < 0 or page_num >= total_pages:
                        return {
                            "success": False,
                            "error": f"Invalid page number: {part} (PDF has {total_pages} pages)"
                        }
                    page_ranges.append((page_num, page_num))

        # Create output directory
        os.makedirs(output_dir, exist_ok=True)

        # Split PDF
        output_files = []
        base_name = Path(file).stem

        for idx, (start, end) in enumerate(page_ranges, 1):
            writer = PdfWriter()
            for page_num in range(start, end + 1):
                writer.add_page(reader.pages[page_num])

            output_path = os.path.join(output_dir, f"{base_name}_part{idx}.pdf")
            with open(output_path, 'wb') as output_file:
                writer.write(output_file)

            output_files.append({
                "name": os.path.basename(output_path),
                "path": output_path
            })

        return {
            "success": True,
            "message": f"Successfully split PDF into {len(output_files)} files",
            "output_files": output_files
        }
    except ValueError as e:
        return {
            "success": False,
            "error": f"Invalid page format: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to split PDF: {str(e)}"
        }


async def extract_text(file: str, pages: Optional[str] = None) -> dict[str, Any]:
    """
    Extract text from PDF pages using pdfplumber.

    Args:
        file: Absolute path to input PDF
        pages: Page ranges to extract (e.g., "1-3,5" or None for all)

    Returns:
        JSON with extracted text by page
    """
    try:
        if not os.path.exists(file):
            return {
                "success": False,
                "error": f"Input file not found: {file}"
            }

        with pdfplumber.open(file) as pdf:
            total_pages = len(pdf.pages)

            # Parse page ranges
            if pages is None or pages.lower() == "all":
                page_nums = list(range(total_pages))
            else:
                page_nums = []
                for part in pages.split(','):
                    part = part.strip()
                    if '-' in part:
                        start, end = part.split('-')
                        start = int(start) - 1  # Convert to 0-indexed
                        end = int(end) - 1
                        if start < 0 or end >= total_pages or start > end:
                            return {
                                "success": False,
                                "error": f"Invalid page range: {part} (PDF has {total_pages} pages)"
                            }
                        page_nums.extend(range(start, end + 1))
                    else:
                        page_num = int(part) - 1  # Convert to 0-indexed
                        if page_num < 0 or page_num >= total_pages:
                            return {
                                "success": False,
                                "error": f"Invalid page number: {part} (PDF has {total_pages} pages)"
                            }
                        page_nums.append(page_num)

            # Extract text
            extracted_text = {}
            for page_num in page_nums:
                page = pdf.pages[page_num]
                text = page.extract_text() or ""
                extracted_text[str(page_num + 1)] = text  # Use 1-indexed for output

            return {
                "success": True,
                "total_pages": total_pages,
                "extracted_pages": len(extracted_text),
                "text": extracted_text
            }
    except ValueError as e:
        return {
            "success": False,
            "error": f"Invalid page format: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to extract text: {str(e)}"
        }


async def extract_tables(file: str, pages: Optional[str] = None, format: str = "json") -> dict[str, Any]:
    """
    Extract tables from PDF pages.

    Args:
        file: Absolute path to input PDF
        pages: Page ranges to extract (e.g., "1-3,5" or None for all)
        format: Output format - "json" or "csv"

    Returns:
        JSON with extracted tables
    """
    try:
        if not os.path.exists(file):
            return {
                "success": False,
                "error": f"Input file not found: {file}"
            }

        if format not in ["json", "csv"]:
            return {
                "success": False,
                "error": f"Invalid format: {format}. Must be 'json' or 'csv'"
            }

        with pdfplumber.open(file) as pdf:
            total_pages = len(pdf.pages)

            # Parse page ranges
            if pages is None or pages.lower() == "all":
                page_nums = list(range(total_pages))
            else:
                page_nums = []
                for part in pages.split(','):
                    part = part.strip()
                    if '-' in part:
                        start, end = part.split('-')
                        start = int(start) - 1
                        end = int(end) - 1
                        if start < 0 or end >= total_pages or start > end:
                            return {
                                "success": False,
                                "error": f"Invalid page range: {part} (PDF has {total_pages} pages)"
                            }
                        page_nums.extend(range(start, end + 1))
                    else:
                        page_num = int(part) - 1
                        if page_num < 0 or page_num >= total_pages:
                            return {
                                "success": False,
                                "error": f"Invalid page number: {part} (PDF has {total_pages} pages)"
                            }
                        page_nums.append(page_num)

            # Extract tables
            all_tables = {}
            for page_num in page_nums:
                page = pdf.pages[page_num]
                tables = page.extract_tables()
                if tables:
                    page_tables = []
                    for table in tables:
                        if format == "csv":
                            # Convert to CSV string
                            df = pd.DataFrame(table[1:], columns=table[0] if table else None)
                            csv_str = df.to_csv(index=False)
                            page_tables.append(csv_str)
                        else:
                            # Keep as JSON
                            page_tables.append(table)
                    all_tables[str(page_num + 1)] = page_tables

            return {
                "success": True,
                "total_pages": total_pages,
                "pages_with_tables": len(all_tables),
                "format": format,
                "tables": all_tables
            }
    except ValueError as e:
        return {
            "success": False,
            "error": f"Invalid page format: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to extract tables: {str(e)}"
        }


async def rotate_pages(file: str, rotation: int, pages: Optional[str] = None, output_path: str = None) -> dict[str, Any]:
    """
    Rotate pages in a PDF.

    Args:
        file: Absolute path to input PDF
        rotation: Rotation angle (90, 180, 270, or -90)
        pages: Page ranges to rotate (e.g., "1-3,5" or None for all)
        output_path: Absolute path for output PDF

    Returns:
        JSON with success status and output_files list
    """
    try:
        if not os.path.exists(file):
            return {
                "success": False,
                "error": f"Input file not found: {file}"
            }

        if rotation not in [90, 180, 270, -90]:
            return {
                "success": False,
                "error": f"Invalid rotation: {rotation}. Must be 90, 180, 270, or -90"
            }

        reader = PdfReader(file)
        total_pages = len(reader.pages)

        # Parse page ranges
        if pages is None or pages.lower() == "all":
            page_nums = list(range(total_pages))
        else:
            page_nums = []
            for part in pages.split(','):
                part = part.strip()
                if '-' in part:
                    start, end = part.split('-')
                    start = int(start) - 1
                    end = int(end) - 1
                    if start < 0 or end >= total_pages or start > end:
                        return {
                            "success": False,
                            "error": f"Invalid page range: {part} (PDF has {total_pages} pages)"
                        }
                    page_nums.extend(range(start, end + 1))
                else:
                    page_num = int(part) - 1
                    if page_num < 0 or page_num >= total_pages:
                        return {
                            "success": False,
                            "error": f"Invalid page number: {part} (PDF has {total_pages} pages)"
                        }
                    page_nums.append(page_num)

        # Set output path
        if output_path is None:
            base = Path(file).stem
            ext = Path(file).suffix
            output_path = str(Path(file).parent / f"{base}_rotated{ext}")

        # Create output directory
        output_dir = os.path.dirname(output_path)
        if output_dir:
            os.makedirs(output_dir, exist_ok=True)

        # Rotate pages
        writer = PdfWriter()
        for i, page in enumerate(reader.pages):
            if i in page_nums:
                page.rotate(rotation)
            writer.add_page(page)

        # Write output
        with open(output_path, 'wb') as output_file:
            writer.write(output_file)

        return {
            "success": True,
            "message": f"Successfully rotated {len(page_nums)} pages by {rotation} degrees",
            "output_files": [{
                "name": os.path.basename(output_path),
                "path": output_path
            }]
        }
    except ValueError as e:
        return {
            "success": False,
            "error": f"Invalid page format: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to rotate pages: {str(e)}"
        }


async def pdf_info(file: str) -> dict[str, Any]:
    """
    Get information and metadata about a PDF file.

    Args:
        file: Absolute path to input PDF

    Returns:
        JSON with PDF metadata and info
    """
    try:
        if not os.path.exists(file):
            return {
                "success": False,
                "error": f"Input file not found: {file}"
            }

        reader = PdfReader(file)
        metadata = reader.metadata or {}

        # Get file size
        file_size = os.path.getsize(file)

        # Format file size
        if file_size < 1024:
            size_str = f"{file_size} bytes"
        elif file_size < 1024 * 1024:
            size_str = f"{file_size / 1024:.2f} KB"
        else:
            size_str = f"{file_size / (1024 * 1024):.2f} MB"

        # Extract metadata
        info = {
            "success": True,
            "file_name": os.path.basename(file),
            "file_path": file,
            "file_size": file_size,
            "file_size_formatted": size_str,
            "page_count": len(reader.pages),
            "metadata": {
                "title": metadata.get("/Title", ""),
                "author": metadata.get("/Author", ""),
                "subject": metadata.get("/Subject", ""),
                "creator": metadata.get("/Creator", ""),
                "producer": metadata.get("/Producer", ""),
                "creation_date": metadata.get("/CreationDate", ""),
                "modification_date": metadata.get("/ModDate", "")
            }
        }

        return info
    except Exception as e:
        return {
            "success": False,
            "error": f"Failed to get PDF info: {str(e)}"
        }


# Initialize FastMCP server
mcp = FastMCP("pdf-mcp-server")


@mcp.tool()
async def merge_pdfs_tool(files: list[str], output_path: str) -> str:
    """
    Merge multiple PDF files into a single PDF.

    Args:
        files: List of absolute paths to PDF files to merge (minimum 2 files)
        output_path: Absolute path where merged PDF should be saved
    """
    result = await merge_pdfs(files, output_path)
    return json.dumps(result, indent=2)


@mcp.tool()
async def split_pdf_tool(file: str, pages: str, output_dir: str) -> str:
    """
    Split a PDF into multiple files based on page ranges.

    Args:
        file: Absolute path to input PDF file
        pages: Page ranges (e.g., '1-3,5,7-9' or 'all')
        output_dir: Directory where split PDFs should be saved
    """
    result = await split_pdf(file, pages, output_dir)
    return json.dumps(result, indent=2)


@mcp.tool()
async def extract_text_tool(file: str, pages: Optional[str] = None) -> str:
    """
    Extract text from PDF pages using pdfplumber.

    Args:
        file: Absolute path to input PDF file
        pages: Page ranges to extract (e.g., '1-3,5' or 'all'). Optional, defaults to all pages
    """
    result = await extract_text(file, pages)
    return json.dumps(result, indent=2)


@mcp.tool()
async def extract_tables_tool(file: str, pages: Optional[str] = None, format: str = "json") -> str:
    """
    Extract tables from PDF pages as JSON or CSV.

    Args:
        file: Absolute path to input PDF file
        pages: Page ranges to extract (e.g., '1-3,5' or 'all'). Optional, defaults to all pages
        format: Output format - 'json' or 'csv'. Defaults to 'json'
    """
    result = await extract_tables(file, pages, format)
    return json.dumps(result, indent=2)


@mcp.tool()
async def rotate_pages_tool(file: str, rotation: int, pages: Optional[str] = None, output_path: Optional[str] = None) -> str:
    """
    Rotate pages in a PDF by 90, 180, 270, or -90 degrees.

    Args:
        file: Absolute path to input PDF file
        rotation: Rotation angle (90, 180, 270, or -90)
        pages: Page ranges to rotate (e.g., '1-3,5' or 'all'). Optional, defaults to all pages
        output_path: Absolute path for output PDF. Optional, defaults to <filename>_rotated.pdf
    """
    result = await rotate_pages(file, rotation, pages, output_path)
    return json.dumps(result, indent=2)


@mcp.tool()
async def pdf_info_tool(file: str) -> str:
    """
    Get metadata and information about a PDF file (page count, size, author, etc.).

    Args:
        file: Absolute path to input PDF file
    """
    result = await pdf_info(file)
    return json.dumps(result, indent=2)


if __name__ == "__main__":
    mcp.run()
