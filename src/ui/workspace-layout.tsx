import { errorMessage } from './api.ts';
import { Link } from 'react-router';
export function PageIntro({ title, description }: { title: string; description: string }) { return <section className="intro"><h1>{title}</h1><p>{description}</p></section>; }
export function QueryError({ error }: { error: unknown }) { return error ? <div className="alert error" role="alert">{errorMessage(error)}</div> : null; }
export function EmptyState({ title, description, to, action }: { title: string; description: string; to?: string; action?: string }) {
  return <div className="empty"><h3>{title}</h3><p>{description}</p>{to && action ? <Link className="button" to={to}>{action}</Link> : null}</div>;
}
