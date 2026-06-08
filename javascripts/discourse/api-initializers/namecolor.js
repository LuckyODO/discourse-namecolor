import { settings } from "virtual:theme";
import { apiInitializer } from "discourse/lib/api";
import {
  applyNameColors,
  buildNameColorRules,
  observeNameColorTargets,
  syncDocumentState,
} from "../lib/namecolor";

export default apiInitializer((api) => {
  const rules = buildNameColorRules(settings);

  syncDocumentState(rules);

  const apply = () => applyNameColors(document, rules);

  api.onPageChange(apply);
  api.decorateCookedElement((element) => applyNameColors(element, rules));

  apply();
  observeNameColorTargets(apply);
});
