import {
  mcpMetadataOptions,
  proxyMcpMetadata,
} from "@/lib/mcp-metadata-proxy";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return proxyMcpMetadata(request);
}

export function OPTIONS() {
  return mcpMetadataOptions();
}
