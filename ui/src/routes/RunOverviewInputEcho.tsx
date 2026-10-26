import { useMemo, useState } from "react";
import { OrcaHighlightedText } from "../syntax/orca/OrcaHighlightedText";
import { CopyButton } from "./runDetailUi";
import { MetaIcon } from "./RunOverviewMetaIcon";

/** Input-file panel: copyable path row plus a collapsible highlighted echo
 *  of the input text (open by default). */
export function InputEcho({ text, path }: { text: string; path?: string }) {
  const [open, setOpen] = useState(true);
  const lineCount = useMemo(() => (text ? text.split("\n").length : 0), [text]);
  return (
    <div className="input-echo">
      {path && (
        <div className="input-row" style={{ borderRadius: text ? "8px 8px 0 0" : undefined }}>
          <MetaIcon name="file" />
          <span className="input-row-path">{path}</span>
          <div className="input-row-actions">
            <CopyButton text={path} title="Copy path" label="copy" />
          </div>
        </div>
      )}
      {text && (
        <>
          <div className="input-echo-head" onClick={() => setOpen((x) => !x)}>
            <span>{lineCount} lines</span>
            <span className="input-echo-chevron">{open ? "▾" : "▸"}</span>
          </div>
          {open && (
            <div className="input-echo-body">
              <OrcaHighlightedText text={text} mode="input" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
