import { useEffect } from 'react'
import { useLocation } from 'react-router'

import { useProjects } from '@/api/queries'
import {
  locationToSave,
  readStoredLastLocation,
  sameLastLocation,
  writeStoredLastLocation,
} from '@/lib/last-location'

/** Remember valid project URLs for the home page's recent-project link, never for navigation. */
export function LastLocationController(): null {
  const location = useLocation()
  const projects = useProjects()

  useEffect(() => {
    const next = locationToSave(location, projects.data)
    if (next === null) return
    // Cheap, but not free: skipping the equal write keeps a re-render storm off the disk-backed
    // storage, and keeps the stored JSON byte-identical across a reload.
    if (sameLastLocation(readStoredLastLocation(), next)) return
    writeStoredLastLocation(next)
  }, [
    location.hash,
    location.pathname,
    location.search,
    projects.data,
  ])

  return null
}
