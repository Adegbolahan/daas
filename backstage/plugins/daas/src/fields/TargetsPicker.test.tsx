import { renderInTestApp } from '@backstage/frontend-test-utils';
import { fireEvent, screen } from '@testing-library/react';
import { MockDaasApi } from '../../dev/fixtures';
import { daasApiRef } from '../api';
import { TargetsPicker } from './TargetsPicker';

describe('TargetsPicker', () => {
  it('offers the team’s provider/region pairs and keeps rollout order', async () => {
    const onChange = jest.fn();
    await renderInTestApp(
      <TargetsPicker
        formData={[{ provider: 'gke', region: 'europe-west1' }]}
        onChange={onChange}
        schema={{ title: 'Targets' }}
        formContext={{ formData: { team: 'payments' } }}
      />,
      { apis: [[daasApiRef, new MockDaasApi()]] },
    );
    const eks = await screen.findByRole('checkbox', { name: /EKS us-east-1/ });
    fireEvent.click(eks);
    expect(onChange).toHaveBeenLastCalledWith([
      { provider: 'gke', region: 'europe-west1' },
      { provider: 'eks', region: 'us-east-1' },
    ]);
  });

  it('asks for the team first', async () => {
    await renderInTestApp(<TargetsPicker onChange={jest.fn()} schema={{ title: 'Targets' }} />, {
      apis: [[daasApiRef, new MockDaasApi()]],
    });
    expect(await screen.findByText(/Choose the team first/)).toBeInTheDocument();
  });
});
