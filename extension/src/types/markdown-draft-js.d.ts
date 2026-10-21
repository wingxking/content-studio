declare module "markdown-draft-js" {
  interface ImageToken {
    type: string;
    src?: string;
    alt?: string;
  }
  interface Options {
    remarkablePlugins?: Array<
      (remarkable: import("remarkable").Remarkable) => void
    >;
    blockTypes?: Record<string, (token: ImageToken) => Record<string, unknown>>;
    blockEntities?: Record<
      string,
      (token: ImageToken) => Record<string, unknown>
    >;
    remarkableOptions?: Record<string, unknown>;
    preserveNewlines?: boolean;
  }
  export function markdownToDraft(
    markdown: string,
    options?: Options,
  ): import("../../core/src/adapters/recovered/types").DraftState;
}
