import React from 'react';

type Props = {
  /** Shown on the always-visible header button, and used to build the localStorage key. */
  title: string;
  /** Unique per section -- persisted as `wow-debug-panel:collapsed:<storageKey>`. */
  storageKey: string;
  /** Used only the first time this section is ever seen (no stored value yet). */
  defaultCollapsed: boolean;
  children: React.ReactNode;
};

type State = {
  collapsed: boolean;
};

const STORAGE_PREFIX = 'wow-debug-panel:collapsed:';

/** Reads persisted collapse state for a section. Falls back to `fallback` if nothing is stored yet,
 * or if localStorage is unavailable (private browsing, tests, SSR) -- collapsing still works within
 * the session, it just won't survive a reload. */
const readStored = (storageKey: string, fallback: boolean): boolean => {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${storageKey}`);
    return raw === null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
};

const writeStored = (storageKey: string, collapsed: boolean): void => {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${storageKey}`, String(collapsed));
  } catch {
    // Nothing to do -- collapsing still works for this session.
  }
};

/**
 * A collapsible header+body wrapper for one debug-panel section.
 *
 * The debug panel used to be one flat list of `<p>` rows per section, which is what made it grow to
 * roughly half the viewport -- there was no way to hide a section you were not currently using.
 * Wrapping each section here, rather than adding a single whole-panel toggle, lets Lighting and
 * Lighting resolve (what the panel exists for right now) stay open while Player and Tests collapse
 * out of the way.
 *
 * Deliberately has no `shouldComponentUpdate`: `LightingControls` next to this uses one to survive
 * the parent's 60/sec `forceUpdate()`, and that comparison is keyed to what IT displays. Reusing (or
 * copying) that pattern here for `collapsed` would risk a toggle whose `setState` gets silently
 * skipped -- a dead button that looks like a bug. This component's own state changes are cheap and
 * infrequent (one click), so it just re-renders normally.
 *
 * The body is hidden with the `hidden` attribute rather than unmounted, so collapsing a section never
 * tears down whatever is inside it (e.g. `LightingControls`' cached `rendered` string).
 */
class CollapsibleSection extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { collapsed: readStored(props.storageKey, props.defaultCollapsed) };
  }

  private toggle = () => {
    this.setState((prev) => {
      const collapsed = !prev.collapsed;
      writeStored(this.props.storageKey, collapsed);
      return { collapsed };
    });
  };

  render() {
    const { title, children } = this.props;
    const { collapsed } = this.state;
    return (
      <div className={`debugSection${collapsed ? ' debugSection--collapsed' : ''}`}>
        <button
          type="button"
          className="debugSection-toggle"
          onClick={this.toggle}
          aria-expanded={!collapsed}
        >
          <span className="debugSection-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          {' '}
          {title}
        </button>
        <div className="debugSection-body" hidden={collapsed}>
          {children}
        </div>
      </div>
    );
  }
}

export default CollapsibleSection;
