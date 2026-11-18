import React from "react";

export function Wrench() {
  return (
    <path
      d="M1 8 6 3a4 4 0 0 1 5-4L8 2l2 2 3-3a4 4 0 0 1-5 5l-5 5a2 2 0 0 1-2-3Z"
      fill="currentColor"
    />
  );
}

export function KimiArt({ state }: { state: string }) {
  const resting = state === "stall";
  const error = state === "error";
  return (
    <>
      <rect width="64" height="64" rx="15" fill="#f8fbff" />
      <path data-part="body" d="M10 39a20 20 0 0 1 40 0v6H10Z" fill="#1d8cf4" />
      <g className="avatar-gaze">
        {error ? (
          <path
            d="m27 25 4 3-4 3m16-7-4 3 4 3"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
          />
        ) : (
          <g className="avatar-eyes">
            <rect
              data-part="eye-l"
              x="28"
              y={resting ? 27 : 23}
              width="4.6"
              height={resting ? 3 : 9}
              rx="2.3"
              fill="#fff"
              transform="rotate(-8 30 28)"
            />
            <rect
              data-part="eye-r"
              x="38"
              y={resting ? 26 : 22}
              width="4.4"
              height={resting ? 3 : 8.5}
              rx="2.2"
              fill="#fff"
              transform="rotate(-8 40 27)"
            />
          </g>
        )}
      </g>
      <path
        data-part="brand-bubble"
        d="M47.5 18v-3a3.2 3.2 0 1 1 3.2 3.2Z"
        fill="#148afa"
      />
      <rect x="9" y="37" width="46" height="15" rx="2" fill="#062e52" />
      <path
        d="m13 41 4 3-4 3"
        fill="none"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g data-part="terminal-lines" className="avatar-terminal">
        <rect
          className="terminal-cursor"
          x="20.5"
          y="47"
          width="6"
          height="1.7"
          rx=".85"
          fill="#1d9cff"
        />
        <path
          className="avatar-detail terminal-character"
          d="M30 43h3m3 0h4m3 0h2"
          fill="none"
          stroke="#9ed6ff"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </g>
      <g className="avatar-prop" data-part="prop" color="#064c92">
        <g transform="translate(45 31) rotate(-30)">
          <Wrench />
        </g>
      </g>
      <path
        className="avatar-wave"
        d="M47 38q5-1 7-8m-3 0 4 2m0-5-1 3"
        stroke="#0665b4"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </>
  );
}

function DshArt({ state }: { state: string }) {
  const sleepy = state === "stall";
  return (
    <>
      <rect x="1.5" y="1.5" width="61" height="61" rx="14" fill="#f3fafb" />
      <g className="avatar-agent-hop">
        <g className="avatar-whale-swim">
          <path
            data-part="body"
            d="M11 25q4-8 16-6 5-3 8-1.4-4 2 1 5.2l8.8 7.4 3-4.2c3.5 9-2 15-5.2 18.4 4 1.1 5 3.7-1.3 3.6l-3.1-.6C27 57 13 48 10.5 38.2Q8.5 31.5 11 25Z"
            fill="var(--avatar-whale-ink)"
          />
          <path
            data-part="tail"
            className="avatar-tail"
            d="M45 28c-4.5-3.5-4.7-8.2-3.3-11.4.4-.9 1-.5 1.3.6.6 2.7 4.4 3 5.2 6.1 2.7-3 5.2-.8 7.4-3.8.7-.8 1.6-.3 1.3.9-.4 4.9-3.9 7.4-7.5 7.8l-1 4Z"
            fill="var(--avatar-whale-ink)"
          />
          <path
            d="M13 29c12-2 19 12 25.3 17.6-5 .6-8-3.8-12.2-5.3-1.8-.7-.9 1.1 0 3.1-4 4.2-14.4-5.7-13.1-15.4Z"
            fill="#f3fafb"
          />
          <path
            d="M34.5 30.5c2.9-.7 5.5 2 6.7 5 0 2.3-3.4 1.3-4.2-.6-.7-1.5-.4-2.3-2.1-2.6-1.4-.2-1.2-1.4-.4-1.8Z"
            fill="#f3fafb"
          />
          <g className="avatar-gaze">
            {state === "error" ? (
              <path
                d="m32 31 3 3m0-3-3 3"
                stroke="#83d6c9"
                fill="none"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            ) : (
              <ellipse
                data-part="eye-l"
                className="avatar-eyes"
                cx="35"
                cy="33"
                rx="1.3"
                ry={sleepy ? 0.55 : 1.3}
                fill="#83d6c9"
              />
            )}
          </g>
          <g data-part="prop" className="avatar-prop" color="#138773">
            <g transform="translate(46 29) rotate(30)">
              <Wrench />
            </g>
          </g>
        </g>
      </g>
      <g
        className="avatar-secondary avatar-water"
        stroke="var(--avatar-whale-ink)"
        fill="none"
        strokeWidth="1.25"
      >
        <circle cx="22" cy="14" r="2.3" />
        <circle cx="17" cy="18" r="1.25" />
        <circle cx="26" cy="9" r="1.25" />
      </g>
      <g
        className="avatar-secondary avatar-ripple"
        stroke="#28aeac"
        fill="none"
        strokeWidth="1.3"
      >
        <path d="M44 40q7 3 13-1m-9 5q4 1 8-1" />
      </g>
      <path
        className="avatar-secondary avatar-celebrate"
        d="M30 20c0-10 3-14 9-14m-9 14c0-6-3-9-7-9m10-2 3-4"
        fill="none"
        stroke="#23a8aa"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        className="avatar-wave"
        d="M42 20q1-8 5-7m-1-3 2 2m1-3v3"
        fill="none"
        stroke="#168c81"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </>
  );
}

// Outer and inner contours use the same winding rule for all six interlocks.
const knot = [
  "M7.5 26q2-6 9-8.5C18 9 27 4.5 36.5 11 45 8.5 55 14 52.5 26c7.5 5 5.5 18-4.5 20.5C46 55 34.5 60 27.5 53 16 55 8.5 47 11.5 38Q5.5 33 7.5 26Z",
  "M19 17q3-8 11.5-6.5l3 1.5v1l-10 5.5v15L19 31.5Z",
  "M26 20.5l10-6C44 11 50 16 50 23.5l-10-5.5L26 25Z",
  "M35 23.5l4-2L50 27q8 6 1 14.5l-3 2v-12Z",
  "M40.5 30.5 45 33v14q-2 7-11.5 6.5l-3-2 10-6Z",
  "M37.5 39 38 43.5 27.5 50Q15 53 14 43.5v-3l11 6Z",
  "M16 20.5v12l13 8-4.5 2.5L14 37q-8-5.5-1-14.5Z",
  "M26.5 28.5 32 25.5 37.5 28.5v7l-5.5 3-5.5-3Z",
].join(" ");

function CodexArt() {
  return (
    <>
      <g className="avatar-agent-hop">
        <g className="avatar-knot-motion">
          <path
            className="avatar-knot-arc"
            data-part="body"
            d={knot}
            fill="#111111"
            fillRule="evenodd"
            stroke="#ffffff"
            strokeWidth="3"
            strokeLinejoin="round"
            paintOrder="stroke"
          />
        </g>
      </g>
      <g className="avatar-prop" data-part="prop" color="#f5f5f5">
        <g transform="translate(44 37) rotate(-30)">
          <Wrench />
        </g>
      </g>
      <path
        className="avatar-detail terminal-character"
        d="m38 46 3 2-3 2m5 .4h3"
        fill="none"
        stroke="#f5f5f5"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <g
        className="avatar-secondary avatar-celebrate"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
      >
        {[0, 60, 120, 180, 240, 300].map((angle, index) => (
          <path
            key={angle}
            className="avatar-petal-light"
            d="M26 10q5-2 10 0"
            transform={`rotate(${angle} 32 32)`}
            style={{ "--petal": index } as React.CSSProperties}
          />
        ))}
      </g>
      <path
        className="avatar-wave"
        d="M45 18q3-7 7-6m-1-3 2 2m1-3v3"
        fill="none"
        stroke="#f5f5f5"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        className="avatar-secondary avatar-ripple"
        d="M22 25q7-9 19-4m-21 7q-2 4-1 7"
        stroke="#f5f5f5"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
    </>
  );
}

const crystalFacets = [
  "M12.5 21 32 9v12Z",
  "M32 9 51.5 21H32Z",
  "M51.5 21 32 32l19.5 11Z",
  "M32 32 51.5 43 32 55Z",
  "M12.5 43 32 32v23Z",
  "M12.5 21 32 32 12.5 43Z",
];

function CursorArt({ state }: { state: string }) {
  return (
    <>
      <rect x="1" y="1" width="62" height="62" rx="15" fill="#201c17" />
      <ellipse
        className="avatar-secondary avatar-shadow"
        cx="32"
        cy="56"
        rx={state === "stall" ? 7 : 10}
        ry="1.6"
        fill="#e7bb85"
      />
      <g data-part="body">
        <path d="m32 9 19.5 12v22L32 55 12.5 43V21Z" fill="#524b42" />
        <path d="M32 9 12.5 21 32 32 51.5 21Z" fill="#675a4e" />
        <path d="M32 32v23l19.5-12-11-6Z" fill="#968779" />
        <path d="M32 32 12.5 43 32 55Z" fill="#786e62" />
        {crystalFacets.map((facet, index) => (
          <path
            key={facet}
            className="avatar-crystal-facet"
            data-part="facet"
            d={facet}
            fill={index % 2 ? "#f7ddb1" : "#fff5d9"}
            style={{ "--facet": index } as React.CSSProperties}
          />
        ))}
        <path d="M14 21h36L32 53V32Z" fill="#f8f1e7" />
        <path d="m32 32 18-11-18 32Z" fill="#d6cbbb" />
      </g>
      <path
        className="avatar-secondary avatar-glint"
        d="M13 21 32 9l19 12m-1 0L32 53"
        stroke={state === "error" ? "var(--danger)" : "#f4c68e"}
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        className="avatar-secondary avatar-lid"
        d="M13 21 32 9l19 12Z"
        fill="#8d7258"
      />
      <g className="avatar-prop" data-part="prop">
        <path
          d="m40 29 1 14 3-4 4 5 2-1-4-5 5-1Z"
          fill="#fdf7ef"
          stroke="#201c17"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </g>
      <circle
        className="avatar-secondary avatar-ripple"
        cx="40"
        cy="29"
        r="6"
        stroke="#f4c68e"
        strokeWidth="1.7"
        fill="none"
      />
      <path
        className="avatar-secondary avatar-celebrate"
        d="M14 21h36L32 53V32Z"
        fill="#ffd19d"
      />
      <path
        className="avatar-wave"
        d="M44 20q5-7 9-4m-1-3 2 2m2-2-1 3"
        fill="none"
        stroke="#f4c68e"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </>
  );
}

export const avatarArt = {
  kimi: KimiArt,
  dsh: DshArt,
  codex: CodexArt,
  cursor: CursorArt,
};
