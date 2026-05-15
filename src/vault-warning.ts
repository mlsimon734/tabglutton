export function vaultWarningFor(value: string): string {
  const v = value.trim();
  if (v.startsWith("~") || v.startsWith("/")) {
    return "Use the vault name (as shown in Obsidian's vault switcher), not a filesystem path.";
  }
  if (v.includes("/")) {
    return 'A vault name shouldn\'t contain "/". Use the name shown in Obsidian, not a path.';
  }
  return "";
}
