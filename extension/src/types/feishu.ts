export interface FeishuRichText {
  initialAttributedTexts?: {
    text?: string | Record<string, string>;
    attribs?: string | Record<string, string>;
  };
  apool?: { numToAttrib?: Record<string, [string, string]> };
  links?: Record<string, { url?: string; href?: string }>;
}

export interface FeishuBlockData {
  type?: string;
  text?: FeishuRichText;
  title?: FeishuRichText;
  children?: string[];
  done?: boolean;
  image?: { token?: string; url?: string; src?: string };
  token?: string;
  url?: string;
  src?: string;
  file_name?: string;
  name?: string;
  columns_id?: string[];
  rows_id?: string[];
  cell_set?: Record<string, string | FeishuCell>;
}

export interface FeishuCell extends FeishuBlockData {
  block_id?: string;
  id?: string;
}

export interface FeishuBlock {
  data: FeishuBlockData;
}
