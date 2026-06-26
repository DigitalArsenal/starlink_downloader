/**
 * Module runner — the single chokepoint through which the host invokes any
 * C++/WASM compute module.
 *
 * It speaks the SDK's PIV (Plugin Invoke) wire protocol — encoding requests and
 * decoding responses with `space-data-module-sdk/invoke` — and runs the module
 * under **WasmEdge** via the command surface (stdin → PIV request, stdout → PIV
 * response). Modules are AOT-compiled at build time (`wasmedge compile`), which
 * makes each invocation ~100x faster than interpreting the emscripten artifact.
 *
 * The same compiled `.wasm` is what runs here and what runs in a browser or any
 * other WasmEdge host — there is no separate TypeScript compute implementation.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  encodePluginInvokeRequest,
  decodePluginInvokeResponse,
} from 'space-data-module-sdk/invoke';
import type { OutputFrame, TypeRef } from 'space-data-module-sdk/host/isomorphic';
import { childLogger } from '../logger.js';
import { WASMEDGE_BIN, wasmEdgeEnv } from '../wasmedge.js';

const log = childLogger({ component: 'module-runner' });

/** Env (with WasmEdge lib path restored) reused across invocations. */
const WASMEDGE_ENV = wasmEdgeEnv();

/** A frame handed to a module on a named input port. */
export interface InputFrame {
  portId: string;
  payload: Uint8Array;
  /** Optional SDS type ref (required by typed modules, e.g. orbpro math-bspline $BSP). */
  typeRef?: TypeRef;
}

/** Permissive type ref — my modules read raw payload bytes regardless of schema. */
const ANY_TYPE: TypeRef = { acceptsAnyFlatbuffer: true };

export class ModuleInvocationError extends Error {
  constructor(
    public readonly methodId: string,
    public readonly code: string | null,
    message: string,
  ) {
    super(`module '${methodId}' failed${code ? ` [${code}]` : ''}: ${message}`);
    this.name = 'ModuleInvocationError';
  }
}

/** A loaded, ready-to-invoke compute module (one WASM artifact). */
export class LoadedModule {
  /** Resolved at first invoke: prefer the AOT artifact when present. */
  private resolvedPath: string | null = null;

  constructor(
    public readonly id: string,
    private readonly wasmPath: string,
    private readonly aotPath: string,
  ) {}

  private artifactPath(): string {
    if (this.resolvedPath === null) {
      this.resolvedPath = existsSync(this.aotPath) ? this.aotPath : this.wasmPath;
      log.debug({ module: this.id, artifact: this.resolvedPath }, 'module artifact resolved');
    }
    return this.resolvedPath;
  }

  private runWasmEdge(request: Uint8Array): Promise<Uint8Array> {
    const path = this.artifactPath();
    return new Promise((resolve, reject) => {
      const child = spawn(WASMEDGE_BIN, [path], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: WASMEDGE_ENV,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      child.on('close', (code) => {
        if (out.length === 0) {
          reject(
            new Error(
              `wasmedge (${this.id}) exited ${code} with no response: ${Buffer.concat(err).toString().slice(0, 400)}`,
            ),
          );
          return;
        }
        resolve(new Uint8Array(Buffer.concat(out)));
      });
      // Ignore EPIPE if the module finishes reading before we finish writing.
      child.stdin.on('error', () => {});
      child.stdin.end(Buffer.from(request));
    });
  }

  /**
   * Invoke a method with named input frames; returns the output frames.
   * Throws {@link ModuleInvocationError} on a non-zero status code.
   */
  async invoke(methodId: string, inputs: InputFrame[]): Promise<OutputFrame[]> {
    const request = encodePluginInvokeRequest({
      methodId,
      inputs: inputs.map((f) => ({ portId: f.portId, payload: f.payload, typeRef: f.typeRef ?? ANY_TYPE })),
    });
    const responseBytes = await this.runWasmEdge(request);
    const response = decodePluginInvokeResponse(responseBytes);
    if (response.statusCode !== 0) {
      throw new ModuleInvocationError(
        methodId,
        response.errorCode,
        response.errorMessage ?? `status ${response.statusCode}`,
      );
    }
    return response.outputFrames ?? response.outputs ?? [];
  }

  // Kept for API symmetry; the WasmEdge runner is stateless (process per invoke).
  async destroy(): Promise<void> {}
}

/** Collect output frames into a map of portId -> payloads (preserving order). */
export function groupByPort(frames: OutputFrame[]): Map<string, Uint8Array[]> {
  const map = new Map<string, Uint8Array[]>();
  for (const f of frames) {
    const list = map.get(f.portId) ?? [];
    list.push(f.payload);
    map.set(f.portId, list);
  }
  return map;
}
