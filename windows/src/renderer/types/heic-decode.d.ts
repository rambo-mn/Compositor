declare module 'heic-decode' {
  interface Decoded { width: number; height: number; data: Uint8ClampedArray }
  function decode(options: { buffer: Uint8Array | ArrayBuffer }): Promise<Decoded>;
  export default decode;
}
