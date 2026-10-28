# Repository instructions

This repository is a standalone Node.js and TypeScript inference gateway. Keep it independent
of any parent repository or application. Model configuration belongs in `models.json`, not in
task-specific application code. Downloaded models, runtimes, credentials, and generated media
must remain ignored by Git.

- Use arrow functions and functional modules, with no classes.
- Keep handwritten source files at most 300 physical lines and lines at most 100 characters.
- Use Prettier with 2-space indentation and a print width of 100.
- Preserve native llama.cpp API behavior, binary audio, streaming, and cancellation.
- Support Windows, Ubuntu, and macOS. CUDA applies to supported NVIDIA systems; macOS uses Metal.
- Every started child process must stop on graceful shutdown, startup failure, and parent exit.
- Keep tests in `tests/`. Unit tests verify gateway behavior; live tests must use actual models.
- Run `npm test`, `npm run lint`, `npm run format:check`, `npm run check:limits`, and
  `npm run build` after source changes. Run `npm run test:live` for model-facing changes when
  the documented runtime and model downloads are available.
- Report observed model limitations; do not replace a failed model test with fabricated output.
- Do not commit or print `.env` values or local credentials.
