// Asset imports used by the standalone UI (Vite turns each into a hashed URL at build time).
declare module '*.webp' { const url: string; export default url; }
declare module '*.png' { const url: string; export default url; }
declare module '*.woff2' { const url: string; export default url; }
