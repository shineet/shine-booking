// The text of a Claude response, from wherever in the response it happens to be.
//
// Everything here used to read `data.content[0].text`, which assumes the first
// block of the reply is the prose. That is not guaranteed and has stopped being
// true: a response can lead with a thinking block, and then block zero has no
// `.text` at all. The redraft button reported "claude-opus-5: empty completion"
// for exactly this reason -- the model had answered perfectly well and the
// answer was in block one.
//
// It reads the same way whether the reply is one block or five, so the caller
// never has to care how the model chose to lay it out.

/// Every text block in the response, joined, trimmed. Empty string if there is
/// genuinely no text -- callers treat that as a failure, and it is.
export function claudeText(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}
