// Small stroke icons (12–14px) drawn to match the UI's hairline style.
const S = (p: { d: string; size?: number; fill?: boolean }) => (
  <svg
    width={p.size ?? 13}
    height={p.size ?? 13}
    viewBox="0 0 16 16"
    fill={p.fill ? "currentColor" : "none"}
    stroke={p.fill ? "none" : "currentColor"}
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={p.d} />
  </svg>
);

export const IconUndo = () => <S d="M5.5 4 2.5 7l3 3M3 7h6.5a4 4 0 0 1 0 8H8" />;
export const IconRedo = () => <S d="M10.5 4l3 3-3 3M13 7H6.5a4 4 0 0 0 0 8H8" />;
export const IconCheck = () => <S d="M3 8.5 6.5 12 13 4.5" />;
export const IconCross = () => <S d="M4 4l8 8M12 4l-8 8" />;
export const IconExport = () => <S d="M8 2v8M5 5l3-3 3 3M3 10v3.5h10V10" />;
export const IconSliders = () => <S d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7M11 3v3M5 10v3" />;
export const IconClose = () => <S d="M4 4l8 8M12 4l-8 8" size={12} />;
export const IconChevL = () => <S d="M10 3.5 5.5 8l4.5 4.5" size={11} />;
export const IconChevR = () => <S d="M6 3.5 10.5 8 6 12.5" size={11} />;
export const IconChevUp = () => <S d="M4 10l4-4 4 4" size={10} />;
export const IconTri = ({ open }: { open: boolean }) => (
  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden style={{ transform: open ? "none" : "rotate(-90deg)" }}>
    <path d="M1 2h6L4 6z" fill="currentColor" />
  </svg>
);
export const IconLasso = () => <S d="M8 3c3.3 0 5.5 1.5 5.5 3.5S11.3 10 8 10 2.5 8.5 2.5 6.5 4.7 3 8 3ZM5 9.5c-.5 1.5.2 3 1.8 3.5" />;
export const IconBrush = () => <S d="M8 8m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0M8 8m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0" />;
export const IconPencil = () => <S d="M10.5 3l2.5 2.5L6 12.5H3.5V10z" size={12} />;
export const IconTrash = () => <S d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5" size={12} />;
export const IconHalf = () => <S d="M8 2.5a5.5 5.5 0 1 0 0 11zM8 2.5a5.5 5.5 0 1 1 0 11" />;
export const IconTarget = () => <S d="M8 8m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0M8 8m-1.6 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0" />;
export const IconEraser = () => <S d="M9.5 3.5l3 3-6 6H4l-1.5-1.5zM7 12.5h6.5" />;
export const IconPin = () => <S d="M8 6m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M8 8.5V14" />;
export const IconKeyboard = () => <S d="M2 4.5h12v7H2zM4.5 7h1M7.5 7h1M10.5 7h1M5 9.5h6" />;
export const IconCircleDash = () => <S d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5M13.5 8A5.5 5.5 0 0 1 8 13.5M8 13.5A5.5 5.5 0 0 1 2.5 8M2.5 8A5.5 5.5 0 0 1 8 2.5" />;
export const IconText = () => <S d="M3 4h10M3 7.5h10M3 11h6M11 10.5l1.5 1.5 2-2.5" />;
