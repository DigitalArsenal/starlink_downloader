/**
 * Ambient declarations for the parts of `space-data-module-sdk` and
 * `spacedatastandards.org` that this host uses. Neither package ships its own
 * TypeScript types; these cover exactly the surfaces we call.
 */

declare module 'space-data-module-sdk/host/isomorphic' {
  export interface TypeRef {
    schemaName?: string;
    fileIdentifier?: string;
    wireFormat?: 'flatbuffer' | 'aligned-binary';
    rootTypeName?: string;
    acceptsAnyFlatbuffer?: boolean;
  }
  export interface OutputFrame {
    portId: string;
    payload: Uint8Array;
    typeRef?: TypeRef;
  }
  export interface InvokeInput {
    portId: string;
    payload: Uint8Array;
    typeRef?: TypeRef;
  }
  export interface InvokeRequest {
    methodId: string;
    inputs: InvokeInput[];
  }
  export interface InvokeResponse {
    statusCode: number;
    errorCode: string | null;
    errorMessage: string | null;
    outputFrames: OutputFrame[];
    outputs: OutputFrame[];
  }
  export interface ModuleHarness {
    runtime: { kind: string; profile?: string; surface?: string };
    invoke(request: InvokeRequest): Promise<InvokeResponse>;
    readManifest(): unknown;
    destroy(): Promise<void>;
  }
  export interface LoadModuleOptions {
    wasmSource: string;
    wasmEdgeBinary?: string;
    enableThreads?: boolean;
    env?: Record<string, string>;
    cwd?: string;
    [key: string]: unknown;
  }
  export function loadModule(options: LoadModuleOptions): Promise<ModuleHarness>;
  export function inspectModule(
    source: Uint8Array | ArrayBuffer,
  ): Promise<{ profile: string; exports: string[]; imports: unknown[] }>;
}

declare module 'space-data-module-sdk/invoke' {
  import type { OutputFrame, InvokeInput } from 'space-data-module-sdk/host/isomorphic';
  export function encodePluginInvokeRequest(request: {
    methodId: string;
    inputs: InvokeInput[];
  }): Uint8Array;
  export function decodePluginInvokeResponse(bytes: Uint8Array): {
    statusCode: number;
    errorCode: string | null;
    errorMessage: string | null;
    outputFrames: OutputFrame[];
    outputs: OutputFrame[];
  };
}

declare module 'space-data-module-sdk' {
  export interface HttpRequestParams {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string | null;
    responseType?: 'bytes' | 'text' | 'json';
    timeoutMs?: number;
  }
  export interface HttpResponse {
    url: string;
    status: number;
    statusText: string;
    ok: boolean;
    headers: Record<string, string>;
    body: Uint8Array | string | unknown;
  }
  export interface NodeHostLike {
    invoke(operation: string, params?: unknown): Promise<unknown>;
  }
  export function createNodeHost(options?: {
    capabilities?: string[];
    fetch?: typeof fetch;
    [key: string]: unknown;
  }): NodeHostLike;

  export interface CompileResult {
    outputPath: string;
    wasmBytes: Uint8Array;
    report: { ok: boolean; issues: Array<{ severity: string; code: string; message: string }> };
    manifestWarnings: string[];
  }
  export function compileModuleFromSource(options: {
    manifest: unknown;
    sourceCode: string;
    language?: 'c' | 'c++' | 'cpp';
    threadModel?: string;
    outputPath?: string;
  }): Promise<CompileResult>;
}

declare module 'spacedatastandards.org' {
  export const standards: Record<string, Record<string, new () => Record<string, unknown>>>;
  export function writeFB(input: unknown): Buffer;
  export function readFB(bytes: Uint8Array): unknown[];
}
