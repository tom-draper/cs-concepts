// Components available in every .mdx page without an import.
import Aside from './Aside.astro';
import Link from './Link.astro';
import Ops from './Ops.astro';
import Step from './Step.astro';
import Steps from './Steps.astro';
import ArrayViz from './viz/ArrayViz.astro';
import GrowthChart from './viz/GrowthChart.astro';
import HashTable from './viz/HashTable.astro';
import LinkedList from './viz/LinkedList.astro';
import Tree from './viz/Tree.astro';

export const components = {
  a: Link,
  Aside,
  Ops,
  Step,
  Steps,
  ArrayViz,
  GrowthChart,
  HashTable,
  LinkedList,
  Tree,
};
