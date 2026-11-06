import type { Settings } from "./settings";

/**
 * Markers modelled on NDP.view's annotation icons: the point is where the
 * student clicked (pole foot / needle tip), so markers never cover it.
 */
export function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, size: number, style: Settings["pinStyle"]) {
  const ink = "rgba(18,18,18,0.9)";
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (style === "flag") {
    // pole + waving pennant (NDP.view "flag" icon)
    const top = y - size * 1.6;
    const fw = size * 0.95, fh = size * 0.62;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, top);
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = ink;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 0.6, top);
    ctx.bezierCurveTo(x + fw * 0.35, top - fh * 0.18, x + fw * 0.65, top + fh * 0.18, x + fw, top + fh * 0.02);
    ctx.lineTo(x + fw, top + fh * 0.98);
    ctx.bezierCurveTo(x + fw * 0.65, top + fh * 1.14, x + fw * 0.35, top + fh * 0.78, x + 0.6, top + fh);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = ink;
    ctx.stroke();
    // foot
    ctx.beginPath();
    ctx.arc(x, y, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = ink;
    ctx.fill();
  } else if (style === "pushpin") {
    // slanted push-pin (NDP.view "pin" icon): needle tip at the point, head up-right
    const hx = x + size * 0.62, hy = y - size * 0.62, r = size * 0.34;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(hx - r * 0.5, hy + r * 0.5);
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.stroke();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = "#3a3a3a";
    ctx.stroke();
    const g = ctx.createRadialGradient(hx - r * 0.35, hy - r * 0.35, r * 0.1, hx, hy, r);
    g.addColorStop(0, "rgba(255,255,255,0.75)");
    g.addColorStop(0.35, color);
    g.addColorStop(1, color);
    ctx.beginPath();
    ctx.arc(hx, hy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = ink;
    ctx.stroke();
  } else if (style === "dot") {
    ctx.beginPath();
    ctx.arc(x, y, size * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = ink;
    ctx.stroke();
  } else {
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.beginPath();
    ctx.moveTo(x - size / 2, y);
    ctx.lineTo(x + size / 2, y);
    ctx.moveTo(x, y - size / 2);
    ctx.lineTo(x, y + size / 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.restore();
}

