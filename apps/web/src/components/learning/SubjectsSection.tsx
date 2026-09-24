import { useId, useState, type FormEvent } from 'react';
import {
  childSubjectResponseSchema,
  type ChildSubject,
  type CreateChildSubjectRequest,
  type UpdateChildSubjectRequest,
} from '@pencillift/contracts';
import { useSession } from '../../lib/session.tsx';
import {
  ActionFeedback,
  FieldError,
  buttonRow,
  hintStyle,
  listReset,
  rowStyle,
  sectionStyle,
  useAction,
} from './feedback.tsx';

const NAME_MAX = 60;

/**
 * Subjects for one child (spec P7 "parent-selected grade/subjects", "subject exclusions"; P8
 * "review for every enabled subject"). The six supported subjects always exist; a family may add
 * custom subjects, which get test dates and notes but no generated practice.
 */
export function SubjectsSection({
  childId,
  childName,
  subjects,
  onChanged,
}: {
  childId: string;
  childName: string;
  subjects: readonly ChildSubject[];
  onChanged: () => void;
}) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const headingId = useId();
  const nameId = useId();
  const nameErrorId = useId();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const base = `/v1/children/${encodeURIComponent(childId)}/subjects`;

  const toggle = (subject: ChildSubject) =>
    void run(subject.id, async () => {
      const body: UpdateChildSubjectRequest = { subjectId: subject.id, enabled: !subject.enabled };
      const { subject: updated } = await api.send('PATCH', base, body, childSubjectResponseSchema);
      onChanged();
      return updated.enabled
        ? `${updated.displayName} is on for ${childName}.`
        : `${updated.displayName} is off: no new daily questions or weekly review for it. Points already earned are kept.`;
    });

  const add = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameError('Name the subject, for example “Music”.');
      return;
    }
    if (trimmed.length > NAME_MAX) {
      setNameError(`Use at most ${NAME_MAX} characters.`);
      return;
    }
    if (subjects.some((s) => s.displayName.toLowerCase() === trimmed.toLowerCase())) {
      setNameError(`${childName} already has a subject called “${trimmed}”.`);
      return;
    }
    setNameError(undefined);
    void run('add', async () => {
      const body: CreateChildSubjectRequest = { subjectKey: 'custom', displayName: trimmed };
      const { subject } = await api.send('POST', base, body, childSubjectResponseSchema);
      setName('');
      onChanged();
      return `Added ${subject.displayName}. You can add its test dates and notes below.`;
    });
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Subjects</h2>
      <p>
        Subjects that are on get daily questions and a weekly review. Turning one off stops new
        practice for it; points {childName} already earned are always kept.
      </p>
      <ActionFeedback feedback={feedback} />
      <ul style={listReset}>
        {subjects.map((subject) => {
          const hintId = `${headingId}-${subject.id}`;
          return (
            <li key={subject.id} style={rowStyle}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={subject.enabled}
                  disabled={busy !== null}
                  onChange={() => toggle(subject)}
                  aria-describedby={hintId}
                  style={{ width: 24, minHeight: 24 }}
                />
                {subject.displayName}
              </label>
              <p id={hintId} style={hintStyle}>
                {subject.enabled ? 'On' : 'Off'}
                {subject.generatedPractice
                  ? ''
                  : ' · Custom subject: PencilLift doesn’t make practice questions for it, but its test dates and notes are kept here.'}
              </p>
            </li>
          );
        })}
      </ul>
      <form onSubmit={add} noValidate aria-label="Add a custom subject">
        <label htmlFor={nameId}>Add a custom subject</label>
        <input
          id={nameId}
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? nameErrorId : undefined}
        />
        <FieldError id={nameErrorId} message={nameError} />
        <div style={buttonRow}>
          <button type="submit" className="btn secondary" disabled={busy !== null}>
            {busy === 'add' ? 'Adding…' : 'Add subject'}
          </button>
        </div>
      </form>
    </section>
  );
}
