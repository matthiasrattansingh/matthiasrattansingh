// Card type -> component. Add a new card type by adding a component here and a
// matching "type" in the JSON.
import CallItCard from './CallItCard.jsx';
import ConceptCard from './ConceptCard.jsx';
import SpreadCard from './SpreadCard.jsx';
import TapeCheckCard from './TapeCheckCard.jsx';

export const CARD_COMPONENTS = {
  callit: CallItCard,
  concept: ConceptCard,
  spread: SpreadCard,
  tapecheck: TapeCheckCard,
};
