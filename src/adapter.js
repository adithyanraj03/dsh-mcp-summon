// MCP tool adapter: turns one upstream MCP tool into a harness ToolDefinition
// with canonical values, durable image content, and the core content vocabulary.
//
// Vendored and trimmed (stdio only, tools only) from @deepseek-ai/dsh-mcp-client
// 0.2.1-rc.3 (MIT, Copyright (c) 2026 DeepSeek) — see THIRD_PARTY_NOTICES.md.
// Function bodies are kept near-verbatim on purpose: this is the code that
// makes a summoned tool behave exactly like an natively bridged one (real
// schemas, native UI rendering, image results admitted to durable storage).

import { isDeepStrictEqual } from 'node:util';
import { specTypeSchemas } from '@modelcontextprotocol/client';
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess';

// Optional peer: only used to sharpen one image-refusal diagnostic. Absent →
// the generic refusal message is used instead; nothing else changes.
let isImageAdmissionError = () => false;
try {
  ({ isImageAdmissionError } = await import('@deepseek-ai/dsh-attachment'));
} catch {
  /* optional peer not installed */
}

/** Raster formats supported by the durable attachment vocabulary. */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Canonical RFC 4648 base64, excluding whitespace and URL-safe aliases. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the row's explicit env. Secrets therefore go in
 * the row's `env` map — anything in `args` lands in argv, visible to `ps`.
 */
export function scrubbedChildEnv(extra) {
  return { ...scrubbedParentEnv(), ...extra };
}

/** Keep a supported advertised schema; unsupported MCP vocabulary falls back to JsonValue. */
export function supportedOutputSchema(candidate) {
  if (candidate === undefined) return undefined;
  try {
    assertSupportedJsonSchema(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Adapt an upstream MCP tool to canonical values and durable image content.
 * Registration, client lifetime, deadlines, and transport belong to the caller.
 * @param ctx - plugin context carrying optional attachment and model services.
 * @param options - upstream tool fields and its raw-result callback.
 * @returns the unregistered ToolRuntime definition.
 */
export function createMcpToolDefinition(ctx, options) {
  const { name, rawName, description, inputSchema } = options;
  const projections = new WeakMap();
  return {
    name,
    description,
    parameters: inputSchema,
    output: createOutput(rawName, supportedOutputSchema(options.outputSchema)),
    execute: createExecutor(ctx, options, projections),
    projectContent(exec, result) {
      const projection = projections.get(exec);
      if (projection === undefined) return undefined;
      projections.delete(exec);
      if (result.isError) return undefined;
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined;
      if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined;
      return projection.content;
    },
  };
}

/** Build the canonical result schema and existing Native text projection. */
function createOutput(rawName, structuredSchema) {
  return {
    schema: {
      type: 'object',
      properties: {
        content: { type: 'array', items: {} },
        structuredContent: structuredSchema ?? {},
      },
      required: structuredSchema === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    },
    render(_args, value) {
      return [{ type: 'text', text: extractText(value.content, rawName) }];
    },
  };
}

/**
 * Invoke the caller-owned raw-result callback and prepare canonical content.
 * MCP isError results reject before image storage so ToolRuntime records failure.
 */
function createExecutor(ctx, options, projections) {
  const { rawName, taskRequired } = options;
  return async (args, exec) => {
    if (taskRequired) throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`);
    const argsObj = typeof args === 'object' && args !== null ? args : {};
    const parsed = specTypeSchemas.CallToolResult['~standard'].validate(
      await options.call(argsObj, exec),
    );
    if (parsed.issues !== undefined) {
      throw new Error(`Tool "${rawName}" returned an invalid MCP result: ${parsed.issues.map((issue) => issue.message).join('; ')}`);
    }
    const result = parsed.value;
    const content = result.content;
    const text = extractText(content, rawName);
    if (result.isError === true) throw new Error(text);
    const value = {
      content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
    if (containsImage(content)) {
      const fallback = [{ type: 'text', text: extractText(content, rawName) }];
      const projected = await prepareImageProjection(ctx, exec, content, rawName);
      projections.set(exec, { value, fallback, content: projected });
    }
    return value;
  };
}

/** Whether an untrusted MCP content array contains a declared image block. */
function containsImage(content) {
  return content.some((value) => isRecord(value) && value.type === 'image');
}

/** Narrow one JSON value to a string-keyed object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow a declared MIME string to the durable image vocabulary. */
function isImageMediaType(value) {
  return IMAGE_MEDIA_TYPES.includes(value);
}

/** Decode one projected image without accepting base64 aliases. */
function decodeImage(block) {
  if (!isImageMediaType(block.mimeType)) throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF');
  if (!CANONICAL_BASE64.test(block.data)) throw new Error('the image data is not canonical base64');
  const data = Buffer.from(block.data, 'base64');
  if (data.toString('base64') !== block.data) throw new Error('the image data is not canonical base64');
  return { data, mediaType: block.mimeType };
}

/**
 * Resolve the active model route and durable store for an image-bearing result.
 * @param ctx - plugin context with optional services.
 * @param exec - exact tool execution whose agent supplies the latest route.
 * @returns the attachment store after exact positive image-capability proof.
 */
async function resolveImageAdmission(ctx, exec) {
  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('no attachment store is mounted');
  const routed = exec.agent?.session.requestHeader()?.config;
  const provider = routed?.provider ?? exec.agent?.options.provider;
  const model = routed?.model ?? exec.agent?.options.model;
  const llm = ctx.get('llm');
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved');
  }
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal);
  } catch {
    throw new Error('the current model route could not be verified');
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`);
  }
  if (exec.signal.aborted) throw new Error('the tool call was canceled before image storage');
  return attachments;
}

/** Stable diagnostic text for an image block that was not admitted. */
function imageDiagnostic(block, reason) {
  return `[image unavailable: ${block.mimeType ?? 'unknown media type'}; ${reason}; raw image data remains available to programmatic callers]`;
}

/**
 * Decode, preflight, and durably save one MCP result's ordered image batch.
 * Any refusal projects every image as text while retaining the canonical raw
 * value for programmatic callers.
 */
async function prepareImageProjection(ctx, exec, content, toolName) {
  const decoded = [];
  const validationErrors = new Map();
  const imageIndexes = [];
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue;
    imageIndexes.push(index);
    try {
      decoded.push(decodeImage(value));
    } catch (error) {
      validationErrors.set(index, error.message);
    }
  }
  if (validationErrors.size > 0) {
    return projectContent(content, toolName, (block, index) => ({
      type: 'text',
      text: imageDiagnostic(block, validationErrors.get(index) ?? 'another image in the same result was invalid'),
    }));
  }
  let attachments;
  try {
    attachments = await resolveImageAdmission(ctx, exec);
  } catch (error) {
    const reason = error.message;
    return projectContent(content, toolName, (block) => ({ type: 'text', text: imageDiagnostic(block, reason) }));
  }
  try {
    const refs = await attachments.saveImages(decoded);
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset]]));
    return projectContent(content, toolName, (_block, index) => ({ type: 'image', attachment: byIndex.get(index) }));
  } catch (error) {
    const reason = isImageAdmissionError(error)
      ? `image admission rejected the result: ${error.message}`
      : 'durable image storage rejected the result';
    return projectContent(content, toolName, (block) => ({ type: 'text', text: imageDiagnostic(block, reason) }));
  }
}

/**
 * Extract text from an MCP content array into a single string.
 * - text blocks: join with '\n'
 * - image/audio/resource blocks: replaced with a placeholder
 */
export function extractText(mcpContent, toolName) {
  return projectContent(mcpContent, toolName).map((block) => block.text).join('\n');
}

/**
 * Project ordered MCP blocks into the core content vocabulary.
 * Text-like runs are newline-coalesced; admitted images split those runs at
 * their original position.
 */
export function projectContent(mcpContent, toolName, image = (block) => ({
  type: 'text',
  text: imageDiagnostic(block, 'this result was not admitted to durable model context'),
})) {
  const projected = [];
  const text = [];
  const flushText = () => {
    if (text.length === 0) return;
    projected.push({ type: 'text', text: text.splice(0).join('\n') });
  };
  for (const [index, value] of mcpContent.entries()) {
    if (!isRecord(value)) {
      text.push('[unsupported MCP content block: expected an object]');
      continue;
    }
    const block = value;
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) text.push(block.text);
        break;
      case 'image':
        flushText();
        projected.push(image(block, index));
        break;
      case 'resource_link':
        if (block.name === undefined || block.uri === undefined) {
          text.push('[resource link unavailable: the MCP block is missing its name or URI]');
        } else {
          text.push(`Resource link: ${block.name} (${block.uri})`);
        }
        break;
      case 'audio':
        text.push(`[audio result unsupported: ${block.mimeType ?? 'unknown media type'}; raw audio data remains available to programmatic callers]`);
        break;
      case 'resource':
        text.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]');
        break;
      default:
        text.push(`[unsupported MCP content type: ${block.type}]`);
    }
  }
  flushText();
  return projected.length > 0
    ? projected
    : [{ type: 'text', text: `(${toolName} returned no model-visible content)` }];
}
