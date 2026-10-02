import React from 'react';
const base = { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false };
export const IconBlocker = (p) => (<svg {...base} {...p}><path d="M7 2.8h6L17.2 7v6L13 17.2H7L2.8 13V7z" /><path d="M7.6 7.6l4.8 4.8M12.4 7.6l-4.8 4.8" /></svg>);
export const IconWarn = (p) => (<svg {...base} {...p}><path d="M10 3.2l7.4 13H2.6z" /><path d="M10 8.2v3.6M10 14.2v.1" /></svg>);
export const IconNote = (p) => (<svg {...base} {...p}><circle cx="10" cy="10" r="7.2" /><path d="M10 9v4.6M10 6.3v.1" /></svg>);
export const IconOk = (p) => (<svg {...base} {...p}><circle cx="10" cy="10" r="7.2" /><path d="M6.6 10.2l2.4 2.4 4.6-5" /></svg>);
export const IconPlay = (p) => (<svg {...base} {...p}><path d="M6.5 4.5l9 5.5-9 5.5z" /></svg>);
export const IconCopy = (p) => (<svg {...base} {...p}><rect x="7" y="7" width="9" height="9" rx="1.8" /><path d="M13 7V5.2c0-.7-.5-1.2-1.2-1.2H5.2C4.5 4 4 4.5 4 5.2v6.6c0 .7.5 1.2 1.2 1.2H7" /></svg>);
export const IconSun = (p) => (<svg {...base} {...p}><circle cx="10" cy="10" r="3.4" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></svg>);
export const IconMoon = (p) => (<svg {...base} {...p}><path d="M16.2 11.6A6.6 6.6 0 018.4 3.8a6.6 6.6 0 107.8 7.8z" /></svg>);
export const IconArrow = (p) => (<svg {...base} {...p}><path d="M4 10h12M11 5l5 5-5 5" /></svg>);
export const IconChevron = (p) => (<svg {...base} {...p}><path d="M6 8l4 4 4-4" /></svg>);
export const IconSpark = (p) => (<svg {...base} {...p}><path d="M10 2.6l1.7 4.7 4.7 1.7-4.7 1.7L10 15.4l-1.7-4.7L3.6 9l4.7-1.7z" /></svg>);
export function Mark({ size = 26 }) {
  return (<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="7" className="mark-bg" /><path d="M9 10.5H7.5v11H9M23 10.5h1.5v11H23" className="mark-fg" fill="none" strokeWidth="2" strokeLinecap="square" /><path d="M12.5 16.4l2.7 2.8 5.3-6" className="mark-fg" fill="none" strokeWidth="2.2" strokeLinecap="square" /></svg>);
}
export const SEV = {
  blocker: { label: 'Will fail', Icon: IconBlocker },
  warning: { label: 'Will bite', Icon: IconWarn },
  note: { label: 'Good to know', Icon: IconNote },
};
