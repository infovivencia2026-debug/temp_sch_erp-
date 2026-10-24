import { useNavigate, useSearchParams } from 'react-router-dom'
import SchoolGallery from './SchoolGallery'

/* The school gallery as a menu item of its own, for every staff workspace
   (owner, 2026-10-24). `?post=<id>` opens that post, which is where the
   "New in the school gallery" notification's View lands. Back returns to
   wherever the person came from, or the home. */
export default function GalleryScreen() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const close = () => (window.history.length > 1 ? navigate(-1) : navigate('/'))
  return <SchoolGallery onClose={close} initialPost={params.get('post')} />
}
