// Components available in every .mdx page without an import.
import Aside from './Aside.astro';
import Frame from './Frame.astro';
import GraphDemo from './GraphDemo.astro';
import HashPlayground from './HashPlayground.astro';
import Link from './Link.astro';
import Ops from './Ops.astro';
import Player from './Player.astro';
import SortDemo from './SortDemo.astro';
import Step from './Step.astro';
import Steps from './Steps.astro';
import ArrayViz from './viz/ArrayViz.astro';
import FenwickViz from './viz/FenwickViz.astro';
import Graph from './viz/Graph.astro';
import GrowthChart from './viz/GrowthChart.astro';
import HashTable from './viz/HashTable.astro';
import LinkedList from './viz/LinkedList.astro';
import Tree from './viz/Tree.astro';

export const components = {
  a: Link,
  Aside,
  Frame,
  GraphDemo,
  HashPlayground,
  Player,
  SortDemo,
  Ops,
  Step,
  Steps,
  ArrayViz,
  FenwickViz,
  Graph,
  GrowthChart,
  HashTable,
  LinkedList,
  Tree,
};
