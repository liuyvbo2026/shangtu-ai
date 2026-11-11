// Kept for existing commands. server.mjs now loads the same local configuration
// whether it is launched directly, by npm, or by the macOS background service.
await import('../server.mjs');
