import { memoryStore } from '../src/store/memory.js'
import { storeConformance } from './store-conformance.js'

storeConformance('memoryStore', () => memoryStore())
