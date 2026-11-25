import type { Tool } from './types';
import { httpTool } from './http';
import { jsonTool } from './json';
import { colorTool } from './color';
import { markdownTool } from './markdown';
import { librariesTool } from './libraries';

/** Tool panels, in menu order. The app mounts one with a ToolContext (see ./types.ts). */
export const TOOLS: Tool[] = [httpTool, jsonTool, colorTool, markdownTool, librariesTool];

export const toolById = (id: string): Tool | undefined => TOOLS.find((x) => x.id === id);

export type { Tool, ToolContext } from './types';
export { renderMarkdown, type MarkdownOptions } from './markdown/render';
export { renderJsonTree, type JsonTreeHandle, type JsonTreeOptions } from './json/tree';
