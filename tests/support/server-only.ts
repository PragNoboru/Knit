// Stand-in for the `server-only` package in unit tests. The real package
// throws outside a React Server environment, and Vitest runs plain Node.
// The build still enforces it (see lib/env.ts).
export {};
