/**
 * Generate a strict, schema-valid SDK `PluginManifest` JSON from a compact
 * module descriptor. This keeps module authoring to a single small `module.json`
 * plus a source file — the verbose manifest is derived, not hand-maintained.
 */
import type { ModuleDescriptor } from './registry.js';

type Port = { portId: string; required: boolean };

function portManifest(p: Port): unknown {
  return {
    portId: p.portId,
    displayName: p.portId,
    minStreams: 1,
    maxStreams: 1,
    required: p.required,
    acceptedTypeSets: [{ setId: `${p.portId}-bytes`, allowedTypes: [{ acceptsAnyFlatbuffer: true }] }],
  };
}

export function generateManifest(d: ModuleDescriptor): unknown {
  const inputs: Port[] = d.inputs.map((portId) => ({ portId, required: true }));
  const outputs: Port[] = d.outputs.map((portId) => ({ portId, required: true }));
  return {
    pluginId: `ephem-${d.id}`,
    name: d.name || d.id,
    version: d.version,
    pluginFamily: d.pluginFamily,
    capabilities: [],
    externalInterfaces: [],
    methods: [
      {
        methodId: d.methodId,
        displayName: d.methodId,
        maxBatch: 1,
        drainPolicy: 'single-shot',
        inputPorts: inputs.map(portManifest),
        outputPorts: outputs.map(portManifest),
      },
    ],
    invokeSurfaces: ['direct', 'command'],
    runtimeTargets: ['wasmedge', 'node', 'browser'],
  };
}
