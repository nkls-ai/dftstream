import { Link } from "react-router-dom";
import { routes } from "../lib/routes";
import { ENTITY_LABEL, NOT_FOUND_OR_NO_ACCESS, type EntityKind } from "../lib/notFoundOrNoAccess";

/**
 * The one "not found" screen for detail pages. A missing id and another
 * org's id render identically, so the page never says which it was.
 */
export function NotFoundState({ entity }: { entity: EntityKind }) {
  return (
    <div className="empty-state" role="status">
      <h2>{`${ENTITY_LABEL[entity]} not found`}</h2>
      <p>{NOT_FOUND_OR_NO_ACCESS}</p>
      <p className="muted">
        If it belongs to another organization, switch to that organization in the sidebar.
      </p>
      <Link to={routes.experiments}>Back to experiments</Link>
    </div>
  );
}
