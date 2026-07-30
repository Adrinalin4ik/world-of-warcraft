import React from 'react';
import { render } from '@testing-library/react';
import Template from './template';

test('renders its placeholder content', () => {
  const { getByText } = render(<Template />);

  expect(getByText('Template works')).toBeInTheDocument();
});
