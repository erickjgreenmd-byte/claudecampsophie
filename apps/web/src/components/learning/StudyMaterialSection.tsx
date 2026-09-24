import { useId, useState, type FormEvent } from 'react';
import {
  STUDY_MATERIAL_KINDS,
  STUDY_MATERIAL_MAX_CHARS,
  studyMaterialResponseSchema,
  type ChildSubject,
  type CreateStudyMaterialRequest,
} from '@pencillift/contracts';
import { useSession } from '../../lib/session.tsx';
import {
  ActionFeedback,
  FieldError,
  buttonRow,
  hintStyle,
  sectionStyle,
  textareaStyle,
  useAction,
} from './feedback.tsx';

type Kind = (typeof STUDY_MATERIAL_KINDS)[number];

const KIND_COPY: Record<Kind, { label: string; hint: string; subjectKey: string | null }> = {
  spelling_list: {
    label: 'Teacher’s spelling list',
    hint: 'One word per line (or separated by commas). Daily practice and the review use these words.',
    subjectKey: 'spelling_vocabulary',
  },
  taught_notes: {
    label: 'Notes on what was taught',
    hint: 'A few words about this week’s topics, for example “long division, remainders”.',
    subjectKey: null,
  },
  reading_passage: {
    label: 'Current reading passage',
    hint: 'Paste the passage text. PencilLift asks order-of-events and detail questions about it.',
    subjectKey: 'reading',
  },
};

/**
 * Teacher spelling lists, taught notes and reading passages (spec P7 "honor teacher spelling
 * lists and current reading passages"; P8 "current study material"). Text only, size-limited
 * per kind exactly as the API enforces.
 */
export function StudyMaterialSection({
  childId,
  childName,
  subjects,
}: {
  childId: string;
  childName: string;
  subjects: readonly ChildSubject[];
}) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const headingId = useId();
  const kindId = useId();
  const subjectId = useId();
  const textId = useId();
  const [kind, setKind] = useState<Kind>('spelling_list');
  const [subject, setSubject] = useState<string>(defaultSubject('spelling_list', subjects));
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const max = STUDY_MATERIAL_MAX_CHARS[kind];

  const changeKind = (next: Kind) => {
    setKind(next);
    setSubject(defaultSubject(next, subjects));
    setError(undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setError('Type the list or notes first.');
      return;
    }
    if (trimmed.length > max) {
      setError(`That is too long for this kind of material: use at most ${max} characters.`);
      return;
    }
    setError(undefined);
    const body: CreateStudyMaterialRequest = {
      kind,
      text: trimmed,
      ...(subject !== '' ? { subjectId: subject } : {}),
    };
    void run('save', async () => {
      const { material } = await api.send(
        'POST',
        `/v1/children/${encodeURIComponent(childId)}/study-materials`,
        body,
        studyMaterialResponseSchema,
      );
      setText('');
      const parts = [`Saved the ${KIND_COPY[material.kind].label.toLowerCase()} for ${childName}.`];
      if (material.spellingWords !== null) {
        parts.push(
          `Found ${material.spellingWords} spelling ${material.spellingWords === 1 ? 'word' : 'words'}.`,
        );
      }
      if (material.kind === 'taught_notes') {
        parts.push(
          material.matchedSkills.length > 0
            ? `Topics recognized: ${material.matchedSkills.map((m) => m.label).join(', ')}.`
            : 'No practice topics were recognized; the notes are kept for your reference.',
        );
      }
      return parts.join(' ');
    });
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Spelling lists and class notes</h2>
      <p>
        Type what the teacher sent home so practice matches class. Topics and word lists only —
        leave out names, photos and other personal details.
      </p>
      <ActionFeedback feedback={feedback} />
      <form onSubmit={submit} noValidate aria-label="Add a spelling list or notes">
        <label htmlFor={kindId}>What is it?</label>
        <select id={kindId} value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
          {STUDY_MATERIAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_COPY[k].label}
            </option>
          ))}
        </select>
        <label htmlFor={subjectId}>Subject</label>
        <select id={subjectId} value={subject} onChange={(e) => setSubject(e.target.value)}>
          <option value="">Any subject</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </select>
        <label htmlFor={textId}>{KIND_COPY[kind].label}</label>
        <textarea
          id={textId}
          value={text}
          maxLength={max}
          onChange={(e) => setText(e.target.value)}
          style={textareaStyle}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${textId}-hint${error ? ` ${textId}-error` : ''}`}
        />
        <p id={`${textId}-hint`} style={hintStyle}>
          {KIND_COPY[kind].hint} {text.length}/{max} characters.
        </p>
        <FieldError id={`${textId}-error`} message={error} />
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

function defaultSubject(kind: Kind, subjects: readonly ChildSubject[]): string {
  const key = KIND_COPY[kind].subjectKey;
  if (key === null) return '';
  return subjects.find((s) => s.subjectKey === key)?.id ?? '';
}
