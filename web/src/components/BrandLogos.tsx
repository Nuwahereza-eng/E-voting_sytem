// Real brand marks for the "Powered by" strip on the landing page.
//
// Inlined as SVG so they render instantly, offline, and can be tinted
// via `currentColor` where the brand is monochrome. Kept here rather
// than as loose .svg files so tree-shaking and colour control are easy.
//
// Sources:
//   - Stellar: official single-colour mark (Simple Icons), tinted with
//     currentColor so it reads on the dark theme.
//   - Google Cloud: official four-colour mark.
//   - Sunbird AI: recreation of the official orange-to-yellow sunbird
//     mark (gradient body + scattered dotted tail), self-coloured.

export function StellarLogo({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      aria-label="Stellar"
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
    >
      <path d="M12.283 1.851A10.154 10.154 0 001.846 12.002c0 .259.01.516.03.773A1.847 1.847 0 01.872 14.56L0 15.005v2.074l2.568-1.309.832-.424.82-.417 14.71-7.496 1.653-.842L24 4.85V2.776l-3.387 1.728-2.89 1.473-13.955 7.108a8.376 8.376 0 01-.07-1.086 8.313 8.313 0 0112.366-7.247l1.654-.843.247-.126a10.154 10.154 0 00-5.682-1.932zM24 6.925L5.055 16.571l-1.653.844L0 19.15v2.072L3.378 19.5l2.89-1.473 13.97-7.117a8.474 8.474 0 01.07 1.092A8.313 8.313 0 017.93 19.248l-.10.054-1.793.914a10.154 10.154 0 0016.119-8.214c0-.26-.01-.522-.03-.78a1.848 1.848 0 011.003-1.785L24 8.992Z" />
    </svg>
  );
}

export function GoogleCloudLogo({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      aria-label="Google Cloud"
      viewBox="0 0 64 64"
      className={className}
    >
      <path
        d="M40.728 20.488l2.05.035 5.57-5.57.27-2.36C44.2 8.657 38.367 6.26 31.993 6.26c-11.54 0-21.28 7.852-24.163 18.488.608-.424 1.908-.106 1.908-.106l11.13-1.83s.572-.947.862-.9A13.88 13.88 0 0 1 32 17.375c3.3.007 6.34 1.173 8.728 3.113z"
        fill="#ea4335"
      />
      <path
        d="M56.17 24.77c-1.293-4.77-3.958-8.982-7.555-12.177l-7.887 7.887c3.16 2.55 5.187 6.452 5.187 10.82v1.392c3.837 0 6.954 3.124 6.954 6.954 0 3.837-3.124 6.954-6.954 6.954H32.007L30.615 48v8.346l1.392 1.385h13.908A18.11 18.11 0 0 0 64 39.647c-.007-6.155-3.1-11.6-7.83-14.876z"
        fill="#4285f4"
      />
      <path
        d="M18.085 57.74h13.9V46.6h-13.9a6.89 6.89 0 0 1-2.862-.622l-2.007.615-5.57 5.57-.488 1.88a18 18 0 0 0 10.926 3.689z"
        fill="#34a853"
      />
      <path
        d="M18.085 21.57A18.11 18.11 0 0 0 0 39.654c0 5.873 2.813 11.095 7.166 14.403l8.064-8.064a6.96 6.96 0 0 1-4.099-6.339c0-3.837 3.124-6.954 6.954-6.954 2.82 0 5.244 1.7 6.34 4.1l8.064-8.064c-3.307-4.353-8.53-7.166-14.403-7.166z"
        fill="#fbbc05"
      />
    </svg>
  );
}

export function SunbirdLogo({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      aria-label="Sunbird AI"
      viewBox="0 0 64 64"
      className={className}
    >
      <defs>
        <linearGradient
          id="sunbird-body"
          x1="44"
          y1="10"
          x2="18"
          y2="46"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#F6C21B" />
          <stop offset="0.45" stopColor="#F2892B" />
          <stop offset="1" stopColor="#EA4E23" />
        </linearGradient>
        <linearGradient
          id="sunbird-tail"
          x1="26"
          y1="34"
          x2="6"
          y2="58"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#F2892B" />
          <stop offset="1" stopColor="#EA4E23" />
        </linearGradient>
      </defs>
      {/* Body: rounded head to the left, wing sweeping up and over to the right */}
      <path
        fill="url(#sunbird-body)"
        d="M43.4 39.6c5.9-8.2 6.4-18.3-.9-24-1.1-.9-2.4.6-1.7 1.8 2.9 5.1 1.5 9.8-1.7 12.3-.3-6.4-4.9-11.6-11.6-12.9C22.9 15.6 16 18.9 13.4 25c-2.2 5.1-1 10.9 3 14.7 3.5 3.3 8 4.6 12.3 4.2 5.9-.5 11.2-.2 14.7-4.3z"
      />
      {/* Beak */}
      <path
        fill="#EA4E23"
        d="M14.6 24.6l-5 1.1c-.8.2-.9 1.3-.1 1.6l4.6 1.7z"
      />
      {/* Eye */}
      <circle cx="26.8" cy="23.2" r="2.1" fill="#FFFFFF" />
      {/* Scattered dotted tail fanning down-left */}
      <g fill="url(#sunbird-tail)">
        <ellipse cx="24.5" cy="39" rx="2.4" ry="1.7" transform="rotate(-35 24.5 39)" />
        <ellipse cx="20.5" cy="42" rx="2.2" ry="1.6" transform="rotate(-35 20.5 42)" />
        <ellipse cx="17" cy="45.5" rx="2" ry="1.5" transform="rotate(-35 17 45.5)" />
        <ellipse cx="14" cy="49" rx="1.8" ry="1.3" transform="rotate(-35 14 49)" />
        <ellipse cx="11.5" cy="52.5" rx="1.5" ry="1.1" transform="rotate(-35 11.5 52.5)" />
        <ellipse cx="28" cy="42.5" rx="2.2" ry="1.6" transform="rotate(-35 28 42.5)" />
        <ellipse cx="24" cy="46" rx="2" ry="1.5" transform="rotate(-35 24 46)" />
        <ellipse cx="20.5" cy="49.5" rx="1.8" ry="1.3" transform="rotate(-35 20.5 49.5)" />
        <ellipse cx="17.5" cy="53" rx="1.5" ry="1.1" transform="rotate(-35 17.5 53)" />
        <ellipse cx="9.5" cy="55.5" rx="1.1" ry="0.9" transform="rotate(-35 9.5 55.5)" />
        <ellipse cx="14.5" cy="56" rx="1.2" ry="0.9" transform="rotate(-35 14.5 56)" />
      </g>
    </svg>
  );
}
