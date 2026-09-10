export function buildNeonApiCommand(cli, path, { method = "GET", query = {}, body } = {}) {
  const args = [cli, "api", path, "--method", method, "--output", "json", "--analytics", "false"];
  for (const [name, value] of Object.entries(query)) args.push("--query", `${name}=${value}`);
  if (body !== undefined) args.push("--data=-");
  return { args, input: body === undefined ? undefined : JSON.stringify(body) };
}
