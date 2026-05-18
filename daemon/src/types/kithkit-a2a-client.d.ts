// Type stub for the optional kithkit-a2a-client runtime dependency.
// The daemon uses `await import('kithkit-a2a-client')` wrapped in try/catch and
// gracefully degrades when the package isn't installed. This declaration keeps
// tsc happy without forcing the package into devDependencies or dirtying the
// import site with @ts-ignore.
declare module 'kithkit-a2a-client' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const A2ANetwork: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const CC4MeNetwork: any;
}
