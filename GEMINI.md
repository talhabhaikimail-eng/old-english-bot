# Agent Search & Browsing Instructions

For any web searches, documentation lookups, or web page retrieval in this project, you must ALWAYS use the `s` CLI tool via terminal commands (`run_command` tool) rather than built-in search or browser subagents.

## Available Commands

### 1. Web Search
Run search queries non-interactively using the `s s` command with the `--json` or `--text` flags:
- **JSON Output (Structured):**
  ```bash
  s s "your search query" --json
  ```
- **Text Output (Human-readable):**
  ```bash
  s s "your search query" --text
  ```
- **Direct Summary (AI answer):**
  ```bash
  s s "your question" --summary
  ```

### 2. Page Browsing / Reading URL Content
To read the contents of a webpage or documentation URL, use the `s o` command with the `--dump` flag and the `native` renderer:
```bash
s o "https://example.com/docs" --dump --renderer native
```

## Guidelines
- Avoid using default web search tools (`search_web`) or default browser subagents when researching/browsing for this repository.
- Use `s` CLI search commands to fetch the most up-to-date documentation or search results.
