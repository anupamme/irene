import { helper } from '@ember/component/helper';

export interface InlineCodeSegment {
  text: string;
  isCode: boolean;
}

// Splits free text on backtick-delimited spans (standard inline-code
// markdown), e.g. 'sent `GET /run?target=1; id`' -> [{text: 'sent ',
// isCode: false}, {text: 'GET /run?target=1; id', isCode: true}]. The
// output-phase prompt instructs the model to wrap literal request
// lines/commands/output in backticks precisely so evidence bullets can be
// rendered this way instead of as one ambiguous run of prose.
export function splitInlineCodeSegments(text: string): InlineCodeSegment[] {
  if (!text) {
    return [];
  }

  // Splitting on a capturing group alternates plain/code chunks: even
  // indices are the text around spans, odd indices are span contents.
  return text
    .split(/`([^`]+)`/)
    .map((chunk, index) => ({ text: chunk, isCode: index % 2 === 1 }))
    .filter((segment) => segment.text !== '');
}

export default helper(([text]: [string]) => splitInlineCodeSegments(text));
