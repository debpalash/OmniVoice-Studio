```markdown
# OmniVoice-Studio Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the core development patterns and conventions used in the OmniVoice-Studio Python codebase. You'll learn about file naming, import/export styles, commit message conventions, and how to write and organize tests. This guide ensures consistency and maintainability when contributing to the project.

## Coding Conventions

### File Naming
- Use **snake_case** for all file names.
  - Example: `audio_processor.py`, `voice_utils.py`

### Import Style
- Use **relative imports** within the package.
  - Example:
    ```python
    from .audio_utils import process_audio
    ```

### Export Style
- Use **named exports** (explicitly define what is exported).
  - Example:
    ```python
    __all__ = ["process_audio", "AudioProcessor"]
    ```

### Commit Messages
- Follow **conventional commit** format.
- Use the `fix` prefix for bug fixes.
- Keep commit messages concise (average 74 characters).
  - Example:
    ```
    fix: correct buffer overflow in audio stream handler
    ```

## Workflows

### Code Contribution Workflow
**Trigger:** When adding or updating code in the repository  
**Command:** `/contribute`

1. Create a new branch for your feature or fix.
2. Write code following the coding conventions above.
3. Use relative imports and named exports.
4. Add or update tests in files matching `*.test.*`.
5. Commit changes using the conventional format (e.g., `fix: ...`).
6. Push your branch and open a pull request.

### Testing Workflow
**Trigger:** When you need to verify code correctness  
**Command:** `/test`

1. Identify or create test files using the `*.test.*` pattern (e.g., `audio_processor.test.py`).
2. Write tests for new or updated functionality.
3. Run tests using the project's preferred method (framework unknown; use standard Python test runners if unsure).
   - Example:
     ```bash
     python -m unittest discover
     ```
4. Ensure all tests pass before merging or submitting a pull request.

## Testing Patterns

- Test files are named with the pattern `*.test.*` (e.g., `module.test.py`).
- The specific testing framework is not specified; use standard Python testing practices (e.g., `unittest`, `pytest`).
- Place tests alongside or near the code they cover for clarity.

**Example test file:**
```python
# audio_processor.test.py
import unittest
from .audio_processor import process_audio

class TestAudioProcessor(unittest.TestCase):
    def test_process_audio(self):
        result = process_audio("input.wav")
        self.assertEqual(result, "expected_output")
```

## Commands
| Command      | Purpose                                 |
|--------------|-----------------------------------------|
| /contribute  | Start the code contribution workflow    |
| /test        | Run and verify tests                    |
```
