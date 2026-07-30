import React from 'react';
import { render } from '@testing-library/react';
import Template from './template';

test('renders learn react link', () => {
  const { getByText } = render(<Template />);
  const linkElement = getByText(/learn react/i);
  expect(linkElement).toBeInTheDocument();
});
