import { Notice } from '../../components/states.tsx';

export function SignInNotConfigured() {
  return (
    <Notice>
      <strong>Parent sign-in isn’t available yet.</strong> The PencilLift account service has not
      been connected in this environment. No account can be created or used here.
    </Notice>
  );
}
