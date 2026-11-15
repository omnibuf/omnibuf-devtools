# List available recipes
default:
    @just --list

# Install dependencies
install:
    pnpm install

# Build unpacked MV3 extension into dist/
build:
    pnpm run build

# Package Chrome, Firefox, and AMO source archives into artifacts/
pack: build
    pnpm run pack

# Regenerate documentation screenshots in docs/screenshots/ via headless Chrome
screenshots: build
    pnpm run screenshots

# Generate 1280x800 24-bit RGB store screenshots in artifacts/store-screenshots/
store-screenshots: build
    pnpm run screenshots:store

# Format all source and documentation files
fmt:
    pnpm run fmt

# Verify code formatting
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
