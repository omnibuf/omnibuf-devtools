# List available recipes
default:
    @just --list

# Install dependencies
install:
    pnpm install

# Build unpacked MV3 extension into dist/
build:
    pnpm run build

# Package unpacked extension into artifacts/omnibuf-devtools.zip
pack: build
    pnpm run pack

# Regenerate documentation screenshots in docs/screenshots/ via headless Chrome
screenshots: build
    pnpm run screenshots

# Format all source and documentation files
fmt:
    pnpm run fmt

# Check code formatting without modifying files
fmt-check:
    pnpm run fmt:check

# Lint and typecheck source and tests
lint:
    pnpm run lint

# Run TypeScript compiler typechecking
typecheck:
    pnpm run typecheck

# Run unit and integration test suite
test:
    pnpm run test

# Run full CI suite (format check, lint, typecheck, build, test)
ci: fmt-check lint build test
