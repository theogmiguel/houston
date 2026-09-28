import { createContext } from 'react'
import type { TagInfo } from '../houston/generated/TagInfo'

export const TagsContext = createContext<TagInfo[]>([])
