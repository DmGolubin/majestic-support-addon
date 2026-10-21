import { React } from "./common";
export type ChatBarButtonFactory = any;
export function ChatBarButton({ tooltip, onClick, buttonProps, children }: any) {
    return <button {...buttonProps} type="button" className="stx-bd-chat-button" title={tooltip} aria-label={tooltip}
        onMouseDown={(e: MouseEvent) => e.preventDefault()} onClick={onClick}>{children}</button>;
}
