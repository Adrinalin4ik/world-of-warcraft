import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import CollapsibleSection from '../collapsible-section';

const STORAGE_PREFIX = 'wow-debug-panel:collapsed:';

beforeEach(() => {
  window.localStorage.clear();
});

describe('CollapsibleSection', () => {
  it('shows its body by default when defaultCollapsed is false', () => {
    render(
      <CollapsibleSection title="Lighting" storageKey="lighting" defaultCollapsed={false}>
        <p>body content</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText('body content')).toBeVisible();
  });

  it('hides its body by default when defaultCollapsed is true', () => {
    render(
      <CollapsibleSection title="Player" storageKey="player" defaultCollapsed={true}>
        <p>body content</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText('body content')).not.toBeVisible();
  });

  it('toggles the body visibility when the header button is clicked', () => {
    render(
      <CollapsibleSection title="Lighting" storageKey="lighting-toggle" defaultCollapsed={false}>
        <p>body content</p>
      </CollapsibleSection>,
    );
    const toggle = screen.getByRole('button', { name: /lighting/i });
    expect(screen.getByText('body content')).toBeVisible();

    fireEvent.click(toggle);
    expect(screen.getByText('body content')).not.toBeVisible();

    fireEvent.click(toggle);
    expect(screen.getByText('body content')).toBeVisible();
  });

  it('persists the collapsed state to localStorage across remounts', () => {
    const { unmount } = render(
      <CollapsibleSection title="Tests" storageKey="tests-persist" defaultCollapsed={false}>
        <p>body content</p>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByRole('button', { name: /tests/i }));
    expect(window.localStorage.getItem(`${STORAGE_PREFIX}tests-persist`)).toBe('true');
    unmount();

    render(
      <CollapsibleSection title="Tests" storageKey="tests-persist" defaultCollapsed={false}>
        <p>body content</p>
      </CollapsibleSection>,
    );
    expect(screen.getByText('body content')).not.toBeVisible();
  });

  it('does not unmount its children when collapsed, only hides them', () => {
    let renderCount = 0;
    const Probe = () => {
      renderCount += 1;
      return <p>probe</p>;
    };
    render(
      <CollapsibleSection title="Lighting" storageKey="lighting-probe" defaultCollapsed={false}>
        <Probe />
      </CollapsibleSection>,
    );
    expect(renderCount).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /lighting/i }));
    // Still in the DOM (just hidden), so a second render pass would not be a fresh mount.
    expect(screen.getByText('probe')).not.toBeVisible();
  });
});
